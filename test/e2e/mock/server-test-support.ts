/**
 * The bench the mock-server unit suites share: a minimal valid scenario, the
 * per-file server lifecycle, wire calls with the client's headers, body
 * parsers, and the typed views of the handle's working state.
 */

import { afterEach } from "bun:test";
import { ADMIN_OWNER as OWNER, ADMIN_REPO as REPO } from "../constants.js";
import { parseScenario, type Scenario } from "../schema.js";
import { type MockHandle, type ServerOptions, startMockServer } from "./server.js";
import type { MockState, MultiMockState } from "./state.js";

export const AUTH = { authorization: "Bearer test-token", "x-github-api-version": "2022-11-28" };

/** A minimal valid scenario; each test overrides only what it exercises. */
export function scenario(overrides: Partial<Scenario> = {}): Scenario {
  return parseScenario(
    {
      name: "unit",
      settings: {},
      expect: { exit_code: 0 },
      ...overrides,
    },
    "mock server unit test",
  );
}

/**
 * Servers per test file: `start` records every handle, and the afterEach this
 * registers on the calling file stops each one still running.
 */
export function mockServerLifecycle(): (
  s: Scenario,
  options?: ServerOptions,
) => Promise<MockHandle> {
  const handles: MockHandle[] = [];
  afterEach(async () => {
    await Promise.all(handles.splice(0).map((h) => h.stop()));
  });
  return async (s, options) => {
    const handle = await startMockServer(s, options);
    handles.push(handle);
    return handle;
  };
}

/** GET/PUT/etc. against the running server with the wire headers by default. */
export async function call(
  h: MockHandle,
  method: string,
  path: string,
  init: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...AUTH, ...init.headers };
  const requestInit: RequestInit = { method, headers };
  if (init.body !== undefined) {
    requestInit.body = JSON.stringify(init.body);
    headers["content-type"] = "application/json";
  }
  return fetch(`${h.url}${path}`, requestInit);
}

/** Parse a response body as an untyped record (test-only convenience). */
export async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

/** Parse a response body as an untyped array (test-only convenience). */
export async function jsonArray(res: Response): Promise<Record<string, unknown>[]> {
  return (await res.json()) as Record<string, unknown>[];
}

/** The single-repo MockState (defined for every non-multi scenario here). */
export function singleState(h: MockHandle): MockState {
  if (h.working.mode !== "single") {
    throw new Error("expected a single-repo MockState on the handle");
  }
  return h.working.state;
}

/** The multi-repo working state (defined for every multi scenario here). */
export function multiState(h: MockHandle): MultiMockState {
  if (h.working.mode !== "multi") {
    throw new Error("expected a multi-repo MultiMockState on the handle");
  }
  return h.working.multi;
}

export const labelsPath = `/repos/${OWNER}/${REPO}/labels`;
