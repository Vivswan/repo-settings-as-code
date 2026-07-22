/**
 * Validate the mock's traffic against GitHub's published OpenAPI contract. The
 * trimmed spec (github-openapi.trimmed.json, produced by
 * .github/scripts/trim-openapi.ts) is a fetched, gitignored artifact loaded
 * from disk - never the network - so validation is always on in run.ts and
 * fuzz.ts without a hermeticity or speed cost. Every logged request's
 * path/method/body and every mock response body is checked; a request to a
 * path/method the spec does not document is a failure, as is a body that
 * violates the schema. A missing spec fails loudly with the fetch command (see
 * load()), never a silent skip.
 *
 * Why validate the MOCK against the real spec: the mock is our stand-in for
 * GitHub, so any drift between what it serves and what GitHub documents is a
 * bug in the mock (or a stale spec). Catching it here means the e2e suite tests
 * the action against a faithful GitHub, not a convenient fiction.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { matchesTemplate } from "../../../src/sections/contract.js";
import type { LoggedRequest } from "../mock/routes.js";

/** A plain JSON object. */
type Json = Record<string, unknown>;

const SPEC_PATH = join(import.meta.dir, "github-openapi.trimmed.json");

/**
 * Split a path into non-empty segments (query already absent from a pathname).
 * Shared by the greedy contents matcher below.
 */
function segments(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

/**
 * True when a concrete pathname matches a spec template. Most GitHub params are
 * one segment, which the shared matchesTemplate handles. The sole exception is
 * the contents endpoint, whose trailing `{path}` absorbs a file path that may
 * itself contain slashes (".github/settings.yml"): for a template ending in
 * `{path}`, match the fixed prefix and let `{path}` take one-or-more remaining
 * segments. This mirrors GitHub's own routing, where `{path}` is greedy.
 */
export function pathMatches(template: string, pathname: string): boolean {
  const templateSegs = segments(template);
  const lastTemplate = templateSegs[templateSegs.length - 1];
  if (lastTemplate === "{path}") {
    const prefix = templateSegs.slice(0, -1);
    const pathSegs = segments(pathname);
    // The prefix must match segment-for-segment, then at least one more
    // segment remains for {path} to absorb.
    if (pathSegs.length <= prefix.length) {
      return false;
    }
    return prefix.every((seg, i) => seg.startsWith("{") || seg === pathSegs[i]);
  }
  return matchesTemplate(template, pathname);
}

/** One contract violation the validator found, ready to fold into a run's failures. */
export interface OpenApiViolation {
  /** "METHOD /pathname" the violation is attributed to. */
  request: string;
  /** Whether the request body or a response body broke the schema. */
  kind: "unknown-route" | "request-body" | "response-body";
  detail: string;
}

/**
 * OpenAPI 3.0 uses `nullable: true` and carries annotation keywords (example,
 * xml, discriminator) that JSON Schema draft-07 ajv does not understand. Rewrite
 * a deep-cloned schema so ajv accepts it: fold nullable into the `type` array,
 * and drop the annotation-only keywords. Pure over a fresh clone; the spec in
 * memory is never mutated.
 *
 * `keepRequired` controls whether `required` survives. Request bodies keep it
 * (they are small and author-controlled - a missing required field there is a
 * real mock bug worth catching). Response bodies drop it: GitHub marks nearly
 * every field of a resource required (every url-template field on a user/repo
 * object), but a mock legitimately serves only the subset the action reads, so
 * enforcing presence would drown the useful signal - type mismatches, bad
 * enums, wrong shapes - in hundreds of "missing url field" lines. Either way the
 * validator still checks that what the mock DOES send is well-typed.
 *
 * When relaxing (keepRequired false), a `oneOf` is rewritten to `anyOf`.
 * Stripping `required` widens each branch, so a value that the spec meant to
 * match EXACTLY one branch can now match several - which fails ajv's oneOf
 * (exactly-one semantics). anyOf (at-least-one) is the correct relaxed reading:
 * the mock's body matching some documented variant is what we want to assert,
 * not that it matches a unique one.
 */
export function toJsonSchema(node: unknown, keepRequired = false): unknown {
  if (Array.isArray(node)) {
    return node.map((child) => toJsonSchema(child, keepRequired));
  }
  if (node === null || typeof node !== "object") {
    return node;
  }
  const input = node as Json;
  const out: Json = {};
  for (const [key, value] of Object.entries(input)) {
    // Annotation/OpenAPI-only keywords ajv would either choke on (xml,
    // discriminator) or that only add noise (example, examples); `nullable`
    // is folded in below; `required` is dropped unless keepRequired.
    if (
      key === "nullable" ||
      key === "example" ||
      key === "examples" ||
      key === "xml" ||
      key === "discriminator"
    ) {
      continue;
    }
    if (key === "required" && !keepRequired) {
      continue;
    }
    // Relaxed variant: oneOf's exactly-one semantics break once required is
    // stripped (widened branches overlap), so read it as anyOf. If the node
    // already carries an anyOf sibling (rare), leave oneOf intact rather than
    // clobber - correctness over the micro-optimization.
    if (key === "oneOf" && !keepRequired && !("anyOf" in input)) {
      out.anyOf = toJsonSchema(value, keepRequired);
      continue;
    }
    out[key] = toJsonSchema(value, keepRequired);
  }
  if (input.nullable === true && out.type !== undefined) {
    // type: "string" -> ["string", "null"]; an existing array gains "null".
    const types = Array.isArray(out.type) ? out.type : [out.type];
    if (!types.includes("null")) {
      out.type = [...types, "null"];
    }
  }
  return out;
}

/** The subset of an OpenAPI operation the validator reads. */
interface Operation {
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: unknown }>;
  };
  responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
}

type PathItem = Record<string, Operation>;

interface OpenApiSpec {
  paths: Record<string, PathItem>;
}

/**
 * The compiled validator: the spec's template paths plus a schema-compiling
 * cache. Built once from the trimmed spec and reused across every scenario in
 * a run, so ajv compiles each schema at most once.
 */
export class OpenApiValidator {
  private readonly ajv: Ajv;
  private readonly templates: string[];
  /** Compiled response-body validators (required relaxed), keyed by schema. */
  private readonly cache = new Map<unknown, ValidateFunction>();
  /** Compiled request-body validators (required kept), keyed by schema. */
  private readonly requiredCache = new Map<unknown, ValidateFunction>();

  constructor(private readonly spec: OpenApiSpec) {
    // strict:false because a trimmed OpenAPI doc still carries vocabulary ajv
    // treats as unknown; validateFormats:false because GitHub's `format`
    // values (e.g. "uri", "date-time") are advisory here and we validate
    // structure, not string formats. addFormats still registers them so a
    // schema naming one does not error.
    this.ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
    addFormats(this.ajv);
    this.templates = Object.keys(spec.paths);
  }

  /**
   * Load the trimmed spec from disk and build a validator. The spec is a
   * FETCHED, gitignored artifact (not committed - it is a ~2MB generated blob),
   * so a fresh clone will not have it yet. When it is missing, throw a loud,
   * actionable error naming the exact command instead of silently skipping
   * validation - always-on means always-on. Local devs run the fetch once; CI
   * restores it from actions/cache or re-fetches on a miss.
   */
  static load(): OpenApiValidator {
    return OpenApiValidator.loadFrom(SPEC_PATH);
  }

  /** load() against an explicit path; the missing-file branch is testable this way. */
  static loadFrom(specPath: string): OpenApiValidator {
    let raw: string;
    try {
      raw = readFileSync(specPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          `the trimmed OpenAPI spec is missing at ${specPath}. It is a fetched, gitignored artifact - generate it with:\n  bun .github/scripts/trim-openapi.ts\nthen re-run. (CI restores it from cache or fetches on a miss.)`,
        );
      }
      throw error;
    }
    const spec = JSON.parse(raw) as OpenApiSpec;
    return new OpenApiValidator(spec);
  }

  /** The spec template that matches a concrete pathname, or null if none. */
  private matchTemplate(pathname: string): string | null {
    for (const template of this.templates) {
      if (pathMatches(template, pathname)) {
        return template;
      }
    }
    return null;
  }

  /** The path templates the loaded spec documents (for the coverage assertion). */
  paths(): readonly string[] {
    return this.templates;
  }

  /**
   * Compile (once) and run a schema against a value; empty array = valid.
   * `keepRequired` selects the request-body variant (presence enforced) vs the
   * response-body variant (presence relaxed); the cache is keyed on both so the
   * two compilations of one shared schema never collide.
   */
  private check(schema: unknown, value: unknown, keepRequired: boolean): string[] {
    if (schema === undefined) {
      return [];
    }
    const cache = keepRequired ? this.requiredCache : this.cache;
    let validate = cache.get(schema);
    if (!validate) {
      validate = this.ajv.compile(toJsonSchema(schema, keepRequired) as object);
      cache.set(schema, validate);
    }
    if (validate(value)) {
      return [];
    }
    return (validate.errors ?? []).map(
      (error) => `${error.instancePath || "(root)"} ${error.message ?? "is invalid"}`,
    );
  }

  private jsonSchema(content: Record<string, { schema?: unknown }> | undefined): unknown {
    return content?.["application/json"]?.schema;
  }

  /**
   * Validate one logged request and its response against the spec. Denied
   * requests (deniedBy set: the 403/404 the permission gate returns) and mock
   * VIOLATION 400s are EXCLUDED: those are the harness's own error shapes, not
   * GitHub payloads, so the spec never documents them. Returns every violation
   * found (0..n) so a run collects them all rather than stopping at the first.
   */
  validateRequest(request: LoggedRequest): OpenApiViolation[] {
    if (request.offSpec) {
      // A raw media type, a synthetic transport fault, or a chaos-corrupt body:
      // deliberately off the contract, so neither status nor shape is checked.
      return [];
    }
    if (request.deniedBy !== undefined) {
      return []; // a permission denial, not a documented GitHub response
    }
    if (request.status < 100) {
      // A non-HTTP status sentinel (e.g. a connection drop logs status 0);
      // no documented response exists. Redundant with offSpec for the built-in
      // faults, but kept so a bare sentinel is never mistaken for a real status.
      return [];
    }
    if (request.status === 400 && isMockViolationBody(request.responseBody)) {
      return []; // the mock's own contract-violation reply
    }
    const label = `${request.method} ${request.pathname}`;
    const template = this.matchTemplate(request.pathname);
    if (template === null) {
      return [
        {
          request: label,
          kind: "unknown-route",
          detail: "path matches no template in the trimmed spec",
        },
      ];
    }
    const method = request.method.toLowerCase();
    const operation = this.spec.paths[template]?.[method];
    if (!operation) {
      return [
        {
          request: label,
          kind: "unknown-route",
          detail: `the spec documents no ${request.method} on "${template}"`,
        },
      ];
    }
    const violations: OpenApiViolation[] = [];
    // Request body. Presence IS enforced (keepRequired true): a request body is
    // small and author-controlled, so a missing required field is a real bug.
    const requestBody = operation.requestBody;
    const requestSchema = this.jsonSchema(requestBody?.content);
    if (request.body !== undefined) {
      if (requestSchema !== undefined) {
        // Validate whatever the client sent - object, array, OR primitive. A
        // primitive where the schema wants an object is real drift; skipping
        // non-objects would fail open (the gap B1 flagged).
        for (const detail of this.check(requestSchema, request.body, true)) {
          violations.push({ request: label, kind: "request-body", detail });
        }
      } else if (requestBody === undefined && typeof request.body !== "string") {
        // The operation documents NO request body at all (a GET/DELETE), yet the
        // client sent a JSON value: GitHub accepts none there, so flag it. A
        // string body is the raw/malformed-client case the harness exercises
        // elsewhere, and an op that documents a body but no application/json
        // schema (rare) has nothing to shape-check, so both fall through.
        violations.push({
          request: label,
          kind: "request-body",
          detail: `${request.method} "${template}" documents no request body, but the client sent one`,
        });
      }
    } else if (requestBody?.required === true) {
      // The operation documents a mandatory body but the client sent none: a
      // real contract break (the mock/section omitted a required payload).
      violations.push({
        request: label,
        kind: "request-body",
        detail: `the spec marks the request body required for ${request.method} "${template}", but the client sent none`,
      });
    }
    // Response status. GitHub's published spec routinely omits error statuses
    // (especially 404s: many endpoints return one that the descriptor never
    // lists), and the mock's absent-probe 404s / 409 conflicts are realistic
    // GitHub behavior - the same rationale as the mock's own statusAllowed. So
    // an undocumented status >= 400 is accepted silently (no body schema to
    // check anyway). An undocumented status < 400 (a 2xx/3xx the spec does not
    // list) is a HARD error: GitHub documents its success statuses, so serving
    // an undocumented one means our EndpointDecl or the mock handler is wrong.
    // This is the drift worth catching (e.g. a PUT that answers 201 where
    // GitHub documents only 200).
    const response = operation.responses?.[String(request.status)];
    if (!response && request.status < 400) {
      violations.push({
        request: label,
        kind: "response-body",
        detail: `the spec lists no ${request.status} response for ${request.method} "${template}"; GitHub documents its success statuses, so an undocumented 2xx/3xx means the EndpointDecl or mock handler serves a status GitHub does not`,
      });
    }
    // Response body SHAPE. server.ts leaves responseBody unset for the cases
    // that must not be checked - raw media types, synthetic faults, off-spec
    // chaos - so anything here is a JSON body the spec should describe,
    // primitives included. Presence is relaxed (keepRequired false): the mock
    // serves the subset of fields the action reads, but their SHAPES are
    // checked. Three sub-cases:
    //   - the documented status carries a JSON schema: validate against it.
    //   - a documented SUCCESS status (< 400) is no-content (a 204, empty
    //     `content`) yet the mock sent a NON-NULL body: a contract break (GitHub
    //     sends none). A null body is the correct empty 204 and is fine.
    //   - a >= 400 status with no schema: the spec routinely omits error bodies,
    //     and a realistic error message body is acceptable, so it is not flagged
    //     (mirrors the undocumented->=400 acceptance above).
    const body = request.responseBody;
    if (body !== undefined && body !== null && response) {
      const schema = this.jsonSchema(response.content);
      if (schema !== undefined) {
        for (const detail of this.check(schema, body, false)) {
          violations.push({ request: label, kind: "response-body", detail });
        }
      } else if (request.status < 400 && isNoContent(response)) {
        violations.push({
          request: label,
          kind: "response-body",
          detail: `the spec documents no response content for ${request.status} on ${request.method} "${template}", but the mock sent a body`,
        });
      }
    }
    return violations;
  }

  /** Validate an entire request log, flattening every request's violations. */
  validateLog(requests: readonly LoggedRequest[]): OpenApiViolation[] {
    return requests.flatMap((request) => this.validateRequest(request));
  }
}

const VIOLATION_PREFIX = "E2E MOCK VIOLATION:";

/**
 * True when a documented response declares NO body content: either no `content`
 * object at all, or one with no media types (a 204-style empty response). The
 * mock returning a body against such a response is a contract break.
 */
function isNoContent(response: { content?: Record<string, unknown> }): boolean {
  return response.content === undefined || Object.keys(response.content).length === 0;
}

/** True when a 400 body is the mock's own violation shape, not a GitHub error. */
function isMockViolationBody(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    typeof (body as Json).message === "string" &&
    ((body as Json).message as string).startsWith(VIOLATION_PREFIX)
  );
}

/**
 * The process-wide validator, compiled once from the trimmed spec on first
 * use. run.ts and fuzz.ts both funnel through the runner, which calls this, so
 * the spec is parsed and its schemas compiled a single time per process.
 */
let shared: OpenApiValidator | undefined;
export function sharedValidator(): OpenApiValidator {
  if (!shared) {
    shared = OpenApiValidator.load();
  }
  return shared;
}

/**
 * Validate one request/response exchange against the trimmed spec, returning
 * plain error strings. A thin adapter over the shared validator for callers
 * that hold the request and its response body separately. The `responseBody`
 * argument, when it is anything OTHER than the omitted/undefined default,
 * overrides request.responseBody - an explicit `null` counts as supplied and
 * overrides (the empty-204 case), whereas omitting the argument (or passing
 * `undefined`) falls back to the request's own field. Using a distinct sentinel
 * rather than `??` is what lets an explicit null win instead of silently
 * falling through. Denied, mock-violation, off-spec, and sentinel exchanges
 * return no errors, matching validateRequest.
 */
const NOT_PROVIDED = Symbol("responseBody-not-provided");
export function validateExchange(
  request: LoggedRequest & { body?: unknown },
  responseBody: unknown = NOT_PROVIDED,
): string[] {
  const resolved = responseBody === NOT_PROVIDED ? request.responseBody : responseBody;
  const entry: LoggedRequest = { ...request, responseBody: resolved };
  return sharedValidator()
    .validateRequest(entry)
    .map((v) => `${v.request} [${v.kind}]: ${v.detail}`);
}
