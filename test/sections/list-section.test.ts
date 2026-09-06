/**
 * The list-section factory's own controls, over variants of the labels declaration (real routes,
 * real slice): what the factory derives and how a wrong declaration fails loudly. The labels
 * suite pins the pilot's prose; this file pins the factory's rules once.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { planContext } from "../../src/sections/contract/plan.js";
import { labelsSection } from "../../src/sections/labels/index.js";
import { LABELS_MOCK } from "../../src/sections/labels/mock.js";
import {
  type ListEndpoints,
  type ListSectionModule,
  listSection,
} from "../../src/sections/shared/list-section.js";
import { generatorFromSlice, uniqueBy } from "../e2e/gen-support.js";
import { mockFragmentFor } from "../e2e/mock/list-fragment.js";
import { Rng } from "../e2e/prng.js";
import { MockApi } from "../mock-api.js";
import { fragmentFake } from "./fragment-fake.js";
import { provePlanIdempotent } from "./plan-idempotence.js";
import { REPO } from "./section-run.js";

const base = labelsSection.decl;
const LIST = "GET /repos/o/r/labels?per_page=100&page=1";

/** The labels dictionary without its update role: a resource GitHub could not edit. */
const { update: _update, ...IMMUTABLE_ENDPOINTS } = base.endpoints;
const immutable = listSection({ ...base, endpoints: IMMUTABLE_ENDPOINTS });

/** The derived mock fake over a variant module, seeded with `live`. */
function fakeFor<Ends extends ListEndpoints, Live extends object>(
  section: ListSectionModule<"labels", Ends, Live, "name">,
  live: Record<string, unknown>[],
) {
  return fragmentFake(section, mockFragmentFor(section, LABELS_MOCK), { labels: live });
}

describe("listSection", () => {
  test("a lens whose fromLive drops a field the write carries fails the re-plan-empty proof naming the field", async () => {
    const dropping = listSection({
      ...base,
      lens: {
        ...base.lens,
        fromLive: ({ description: _dropped, ...rest }) => ({
          ...rest,
          color: rest.color.toLowerCase(),
        }),
      },
    });
    const live = [{ name: "bug", color: "d73a4a", description: "x" }];
    const proof = provePlanIdempotent(dropping, fakeFor(dropping, live), [
      { name: "bug", color: "d73a4a", description: "y" },
    ]);
    await expect(proof).rejects.toThrow(/would not converge/);
    await expect(proof).rejects.toThrow(/labels\[bug\]\.description/);
    // The control: the shipped lens converges over the same state and declaration.
    const { second } = await provePlanIdempotent(labelsSection, fakeFor(labelsSection, live), [
      { name: "bug", color: "d73a4a", description: "y" },
    ]);
    expect(second.ops).toEqual([]);
  });

  test("without a fold or a rename key, identities match exactly and the update carries the name under its own field", async () => {
    const exact = listSection({
      ...base,
      identity: { field: "name" },
    });
    const api = fakeFor(exact, [
      { name: "Bug", color: "ffffff", description: null },
      { name: "bug", color: "000000", description: null },
    ]);
    const { changes, second } = await provePlanIdempotent(exact, api, [
      { name: "bug", color: "d73a4a" },
    ]);
    // "Bug" is a different label under exact matching: deleted as undeclared, not renamed.
    expect(changes).toEqual(['updated label "bug"', 'DELETED undeclared label "Bug"']);
    expect(second.ops).toEqual([]);
    expect(api.state.labels.map((label) => [label.name, label.color])).toEqual([["bug", "d73a4a"]]);
  });

  test("two live items one fold apart are a conflict for the entry claiming them, never silently one", async () => {
    const api = new MockApi({
      [LIST]: {
        data: [
          { name: "bug", color: "000000", description: null },
          { name: "BUG", color: "ffffff", description: null },
        ],
      },
    });
    await expect(
      labelsSection.plan(planContext(labelsSection, api, REPO), [{ name: "bug" }]),
    ).rejects.toThrow(/"bug" matches 2 separate live labels \("bug", "BUG"\)/);
    // Unclaimed, both are undeclared and both are removed.
    const unclaimed = await labelsSection.plan(planContext(labelsSection, api, REPO), []);
    expect(unclaimed.ops.map((op) => [op.role, op.params?.name])).toEqual([
      ["remove", "bug"],
      ["remove", "BUG"],
    ]);
  });

  test("the declaration's types close the shape: same params on both item routes, no undefined write fields, matchBy over entry fields", () => {
    listSection({
      ...base,
      endpoints: {
        ...base.endpoints,
        remove: {
          route: "DELETE /repos/{owner}/{repo}/milestones/{milestone_number}",
          statuses: { 204: "x" },
        },
      },
      // @ts-expect-error update addresses {name} and remove {milestone_number}: no address is declarable, not even a throwing one
      address: (): never => {
        throw new Error("unreachable");
      },
    });
    listSection({
      ...base,
      endpoints: {
        ...base.endpoints,
        // @ts-expect-error a fifth role is not served: the factory derives handlers for exactly the four
        probe: { route: "GET /repos/{owner}/{repo}/labels/{name}", statuses: { 200: "x" } },
      },
    });
    listSection({
      ...base,
      // @ts-expect-error a DELETE cannot pose as the update role; without a PATCH or PUT the role is absent
      endpoints: { ...IMMUTABLE_ENDPOINTS, update: IMMUTABLE_ENDPOINTS.remove },
    });
    const unreachable = (): never => {
      throw new Error("unreachable");
    };
    listSection({
      ...base,
      // @ts-expect-error a dictionary widened to the union cannot say which roles it has, so it is refused outright
      endpoints: base.endpoints as ListEndpoints,
      address: unreachable,
    });
    // A conditional between two literal dictionaries is a union too: keyof would hide the
    // second arm's DELETE-as-update, so the union is refused before any per-role pin runs.
    const flag = Boolean(process.env.LIST_SECTION_NEVER_SET);
    listSection({
      ...base,
      // @ts-expect-error a union of two dictionaries is refused for the same reason
      endpoints: flag
        ? IMMUTABLE_ENDPOINTS
        : { ...IMMUTABLE_ENDPOINTS, update: IMMUTABLE_ENDPOINTS.remove },
      address: unreachable,
    });
    listSection({
      ...base,
      lens: {
        ...base.lens,
        // @ts-expect-error an omitted optional stays out of the write; undefined is not a wire value
        toWrite: (label) => ({ name: label.name, color: label.color }),
      },
    });
    listSection({
      ...base,
      // @ts-expect-error matchBy names entry fields, so a misspelled list path cannot go silently unused
      lens: { ...base.lens, matchBy: { colr: "id" } },
    });
  });

  test("two entries claiming one identity are rejected before any read", async () => {
    const api = new MockApi({ [LIST]: { data: [] } });
    await expect(
      labelsSection.plan(planContext(labelsSection, api, REPO), [
        { name: "a", new_name: "b" },
        { name: "B" },
      ]),
    ).rejects.toThrow(/name the same labels entry: "b" and "B"/);
    expect(api.calls).toEqual([]);
  });

  test("the prose hooks reword the keep-note and the delete drift; nothing else is customizable", async () => {
    const worded = listSection({
      ...base,
      prose: {
        undeclaredAction: "REMOVE them",
        undeclaredNote: { state: "lingers", add: "them", manage: "their fate" },
        undeclaredDrift: { state: "a stray", add: "them", keep: "them" },
      },
    });
    const live = [{ name: "stray", color: "ffffff", description: null }];
    const plan = (declared: Parameters<typeof worded.plan>[1]) =>
      worded.plan(planContext(worded, new MockApi({ [LIST]: { data: live } }), REPO), declared);
    expect((await plan({ undeclared: "keep", entries: [] })).notes).toEqual([
      'label "stray" lingers in the settings file; kept under "undeclared: keep" - add them to the settings file to manage their fate, or set "undeclared: delete" to have apply REMOVE them',
    ]);
    expect((await plan([])).ops.map((op) => op.drift)).toEqual([
      [
        "labels[stray]: undeclared - a stray, so apply will REMOVE them; add them to the settings file to keep them",
      ],
    ]);
    // The hook-creep gate: a third hook is an excess property and does not compile.
    listSection({
      ...base,
      // @ts-expect-error the prose surface is exactly the action and the two wording hooks
      prose: { undeclaredAction: "DELETE it", changeSuffix: " (and more)" },
    });
  });

  test("declared secret values are listed per entry in both value forms", () => {
    const secretive = listSection({
      ...base,
      secretValues: (label) =>
        label.description === undefined ? [] : [{ label: label.name, value: label.description }],
    });
    const entries = [
      { name: "a", description: "$A" },
      { name: "b" },
      { name: "c", description: "$C" },
    ];
    const listed = [
      { label: "a", value: "$A" },
      { label: "c", value: "$C" },
    ];
    expect(secretive.secretValues?.(entries)).toEqual(listed);
    expect(secretive.secretValues?.({ undeclared: "keep", entries })).toEqual(listed);
    expect(labelsSection.secretValues).toBeUndefined();
  });
});

describe("listSection without an update role", () => {
  test("a drifted item is deleted then recreated, in that order, and the re-plan is empty", async () => {
    const api = fakeFor(immutable, [
      { name: "bug", color: "000000", description: "keep me" },
      { name: "stale", color: "ffffff", description: null },
    ]);
    const { first, second, changes } = await provePlanIdempotent(immutable, api, [
      { name: "bug", color: "d73a4a" },
    ]);
    expect(first.ops.map((op) => [op.role, op.drift])).toEqual([
      [
        "remove",
        [
          "labels[bug]: live settings differ from the settings file, and labels cannot be edited; apply will delete and recreate it",
        ],
      ],
      // The field line carries no remedy of its own: the generic line above named it.
      ["create", ['labels[bug].color: declared "d73a4a" != live "000000"']],
      [
        "remove",
        [
          "labels[stale]: undeclared - not in the settings file, so apply will DELETE it; add it to the settings file to keep it",
        ],
      ],
    ]);
    expect(changes).toEqual([
      'deleted label "bug" to recreate it with the declared settings',
      'recreated label "bug"',
      'DELETED undeclared label "stale"',
    ]);
    expect(api.writes).toEqual([
      "DELETE /repos/o/r/labels/bug",
      "POST /repos/o/r/labels",
      "DELETE /repos/o/r/labels/stale",
    ]);
    expect(second.ops).toEqual([]);
    // Without a recreate seam the create body is the write: the undeclared description is gone.
    expect(api.state.labels.map((label) => [label.name, label.color, label.description])).toEqual([
      ["bug", "d73a4a", null],
    ]);
  });

  test("the recreate seam carries a live field the write leaves undeclared onto the create", async () => {
    const seeded = listSection({
      ...base,
      endpoints: IMMUTABLE_ENDPOINTS,
      recreate: (live, write) => ({ ...write, description: live.description ?? "" }),
    });
    const api = fakeFor(seeded, [{ name: "bug", color: "000000", description: "keep me" }]);
    const { second } = await provePlanIdempotent(seeded, api, [{ name: "bug", color: "d73a4a" }]);
    expect(second.ops).toEqual([]);
    expect(api.state.labels.map((label) => [label.color, label.description])).toEqual([
      ["d73a4a", "keep me"],
    ]);
    // The seam exists only for an immutable resource: an updatable declaration cannot carry one.
    listSection({
      ...base,
      // @ts-expect-error recreate is never on a dictionary with an update role
      recreate: (_live, write) => write,
    });
  });

  test("the derived mock fragment serves no update handler, and the record type has no such key", () => {
    const fragment = mockFragmentFor(immutable, LABELS_MOCK);
    expect(Object.keys(fragment)).toEqual(["labels.list", "labels.create", "labels.remove"]);
    // @ts-expect-error no update role, no update handler key
    fragment["labels.update"];
    expect(Object.keys(mockFragmentFor(labelsSection, LABELS_MOCK))).toContain("labels.update");
  });

  test("the derived create rejects what the spec declares unique: the folded identity, or the declared key", async () => {
    const live = [{ name: "bug", color: "d73a4a", description: null }];
    const post = async (spec: typeof LABELS_MOCK, body: Record<string, unknown>) => {
      const api = fragmentFake(labelsSection, mockFragmentFor(labelsSection, spec), {
        labels: live,
      });
      const result = await api.tryRequest("POST", "/repos/o/r/labels", body);
      return "error" in result ? result.error.status : 201;
    };
    // "identity": the folded name is unique; another color under the same name is refused.
    expect(await post(LABELS_MOCK, { name: "BUG", color: "ffffff" })).toBe(422);
    expect(await post(LABELS_MOCK, { name: "docs", color: "d73a4a" })).toBe(201);
    // Declared: the color is unique instead, so the same name passes and the same color is refused.
    const byColor = {
      ...LABELS_MOCK,
      unique: (item: Record<string, unknown>) => String(item.color),
    };
    expect(await post(byColor, { name: "BUG", color: "ffffff" })).toBe(201);
    expect(await post(byColor, { name: "docs", color: "d73a4a" })).toBe(422);
    // The choice is explicit: a spec that names nothing unique does not compile.
    const { unique: _unique, ...silent } = LABELS_MOCK;
    // @ts-expect-error `unique` is required, so identity uniqueness is never an accidental default
    mockFragmentFor(labelsSection, silent);
  });
});

describe("listSection listing", () => {
  test("the query knob rides on every page of the list read", async () => {
    const queried = listSection({ ...base, listing: { query: { state: "all" } } });
    const api = new MockApi({
      "GET /repos/o/r/labels?state=all&per_page=100&page=1": { data: [] },
    });
    await queried.plan(planContext(queried, api, REPO), []);
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /repos/o/r/labels?state=all&per_page=100&page=1",
    ]);
  });

  test("an unpaginated list is one bare GET on both sides: the section sends no page params and the derived mock ignores them", async () => {
    const whole = listSection({ ...base, listing: { unpaginated: true } });
    const api = new MockApi({ "GET /repos/o/r/labels": { data: [] } });
    await whole.plan(planContext(whole, api, REPO), []);
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /repos/o/r/labels"]);
    const live = [
      { name: "a", color: "ffffff", description: null },
      { name: "b", color: "ffffff", description: null },
    ];
    const served = async (section: typeof labelsSection): Promise<number> => {
      const result = await fakeFor(section, live).tryRequest("GET", "/repos/o/r/labels?per_page=1");
      return "data" in result ? (result.data as unknown[]).length : -1;
    };
    expect(await served(whole)).toBe(2);
    // The control: the paged fragment honors per_page.
    expect(await served(labelsSection)).toBe(1);
  });
});

describe("listSection conflicts", () => {
  const clashing = listSection({
    ...base,
    conflicts: {
      declared: (writes) =>
        writes.flatMap((write, index) =>
          writes.slice(0, index).some((earlier) => earlier.color === write.color)
            ? [`"${write.name}" repeats a declared color`]
            : [],
        ),
      live: (writes, live) =>
        writes.flatMap((write) => {
          const holder = live.find(
            (item) => item.name !== write.name && item.color === write.color,
          );
          return holder === undefined
            ? []
            : [`"${write.name}" reuses the color of "${holder.name}"`];
        }),
    },
  });
  const live = [
    { name: "bug", color: "d73a4a", description: null },
    { name: "docs", color: "0075ca", description: null },
  ];

  test("a declared-only conflict fails before any request, every line in one error", async () => {
    const api = new MockApi({});
    await expect(
      clashing.plan(planContext(clashing, api, REPO), [
        { name: "a", color: "000000" },
        { name: "b", color: "000000" },
        { name: "c", color: "000000" },
      ]),
    ).rejects.toThrow(
      'labels: the settings file declares conflicting labels: "b" repeats a declared color; "c" repeats a declared color. Fix the settings file, then re-run',
    );
    expect(api.calls).toEqual([]);
  });

  test("a live conflict fails after the one read and before any write, every line in one error", async () => {
    const api = new MockApi({ [LIST]: { data: live } });
    await expect(
      clashing.plan(planContext(clashing, api, REPO), [
        { name: "defect", color: "d73a4a" },
        { name: "flaw", color: "ffffff" },
        { name: "guide", color: "0075ca" },
      ]),
    ).rejects.toThrow(
      'labels: the settings file conflicts with the live labels: "defect" reuses the color of "bug"; "guide" reuses the color of "docs". Resolve each conflict on GitHub, then re-run',
    );
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([LIST]);
  });

  test("no conflict reported, no interference: the plan proceeds as without the hook", async () => {
    const api = new MockApi({ [LIST]: { data: live } });
    const planned = await clashing.plan(planContext(clashing, api, REPO), [
      { name: "defect", color: "000000" },
    ]);
    expect(planned.ops.map((op) => op.role)).toEqual(["create", "remove", "remove"]);
  });
});

describe("uniqueBy", () => {
  test("a repeated identity gets the entry's index appended until it is free, across the pooled fields, under the fold", () => {
    expect(
      uniqueBy(
        [
          { name: "bug", new_name: "BUG" },
          { name: "Bug", color: "x" },
          { name: "bug-1" },
          { name: 7 },
        ],
        ["name", "new_name"],
        (name) => name.toLowerCase(),
      ),
    ).toEqual([
      { name: "bug", new_name: "BUG-0" },
      { name: "Bug-1", color: "x" },
      { name: "bug-1-2" },
      { name: 7 },
    ]);
    // The control: distinct identities pass through untouched, and the input is not mutated.
    const input = [{ name: "a" }, { name: "b" }];
    expect(uniqueBy(input, ["name"])).toEqual(input);
    expect(uniqueBy([{ name: "a" }, { name: "A" }], ["name"])).toEqual([
      { name: "a" },
      { name: "A" },
    ]);
  });
});

describe("generatorFromSlice", () => {
  test("a refined field without a pool fails loudly naming its full path, never emitting an invalid entry", () => {
    const refined = z.object({ name: z.string(), color: z.string().regex(/^[0-9a-f]{6}$/) });
    expect(() => generatorFromSlice(refined)(new Rng(1))).toThrow(
      /the drawn value at "color" fails the slice .* - seed the field with a pool/,
    );
    const nested = z.object({ config: z.object({ url: z.string().url() }) });
    expect(() => generatorFromSlice(nested)(new Rng(1))).toThrow(/at "config\.url"/);
    const pooled = generatorFromSlice(refined, {
      fields: { color: (rng) => rng.pick(["d73a4a", "a2eeef"]) },
    });
    for (let i = 0; i < 50; i++) {
      expect(refined.safeParse(pooled(new Rng(i))).success).toBe(true);
    }
  });

  test("wrapped fields draw their inner type: a defaulted enum yields both members across seeds", () => {
    const wrapped = z.object({
      state: z.enum(["open", "closed"]).default("open"),
      pinned: z.boolean().catch(false),
    });
    const gen = generatorFromSlice(wrapped);
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      seen.add(String(gen(new Rng(i)).state));
    }
    expect([...seen].sort()).toEqual(["closed", "open"]);
  });
});
