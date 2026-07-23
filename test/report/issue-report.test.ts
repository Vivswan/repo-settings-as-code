import { describe, expect, test } from "bun:test";
import {
  deliverIssueReport,
  ISSUE_TITLE,
  injectMarkerLabel,
  MARKER_LABEL,
  MARKER_LABEL_CONFIG,
} from "../../src/report/issue-report.js";
import type { SettingsFile } from "../../src/schema.js";
import { MockApi } from "../mock-api.js";

const SLUG = "o/private-repo";
const LABEL_CREATE = "POST /repos/o/private-repo/labels";
const LABEL_LOOKUP =
  "GET /repos/o/private-repo/issues?state=all&labels=settings-as-code-report&per_page=100";
const ISSUE_CREATE = "POST /repos/o/private-repo/issues";
const CREATOR_SCAN =
  "GET /repos/o/private-repo/issues?state=all&creator=bot&sort=created&direction=asc&per_page=100&page=1";

const reportIssue = (number: number) => ({
  number,
  title: ISSUE_TITLE,
  state: "open",
  html_url: `https://github.com/o/private-repo/issues/${number}`,
});

describe("deliverIssueReport", () => {
  test("found by marker label: one lookup request, then PATCH body + open", async () => {
    const api = new MockApi({
      [LABEL_CREATE]: { error: { status: 422, message: "already_exists", body: "" } },
      [LABEL_LOOKUP]: { data: [reportIssue(7)] },
      "PATCH /repos/o/private-repo/issues/7": { data: reportIssue(7) },
    });
    const result = await deliverIssueReport(api, SLUG, "the report body", true);
    expect(result).toEqual({ url: "https://github.com/o/private-repo/issues/7" });
    const lookups = api.calls.filter((c) => c.method === "GET");
    expect(lookups).toHaveLength(1);
    const patch = api.calls.find((c) => c.method === "PATCH");
    expect(patch?.payload).toEqual({ body: "the report body", state: "open" });
  });

  test("a healthy result closes the issue on update", async () => {
    const api = new MockApi({
      [LABEL_CREATE]: { error: { status: 422, message: "already_exists", body: "" } },
      [LABEL_LOOKUP]: { data: [reportIssue(7)] },
      "PATCH /repos/o/private-repo/issues/7": { data: reportIssue(7) },
    });
    await deliverIssueReport(api, SLUG, "body", false);
    const patch = api.calls.find((c) => c.method === "PATCH");
    expect(patch?.payload).toEqual({ body: "body", state: "closed" });
  });

  test("pull requests and other titles never match, even with the marker label", async () => {
    const api = new MockApi({
      [LABEL_CREATE]: { data: MARKER_LABEL_CONFIG },
      [LABEL_LOOKUP]: {
        data: [
          { ...reportIssue(1), pull_request: { url: "pr" } },
          { ...reportIssue(2), title: `${ISSUE_TITLE} (fork)` },
        ],
      },
      "GET /user": { data: { login: "bot" } },
      [CREATOR_SCAN]: { data: [] },
      [ISSUE_CREATE]: { data: reportIssue(9) },
    });
    const result = await deliverIssueReport(api, SLUG, "body", true);
    expect(result).toEqual({ url: "https://github.com/o/private-repo/issues/9" });
    const create = api.calls.find((c) => `${c.method} ${c.path}` === ISSUE_CREATE);
    expect(create?.payload).toEqual({ title: ISSUE_TITLE, body: "body", labels: [MARKER_LABEL] });
  });

  test("label-lookup miss runs the creator scan BEFORE any create, avoiding duplicates", async () => {
    const api = new MockApi({
      [LABEL_CREATE]: { data: MARKER_LABEL_CONFIG },
      [LABEL_LOOKUP]: { data: [] },
      "GET /user": { data: { login: "bot" } },
      // The label was stripped by a human; the scan still finds the issue.
      [CREATOR_SCAN]: { data: [reportIssue(3)] },
      "PATCH /repos/o/private-repo/issues/3": { data: reportIssue(3) },
    });
    const result = await deliverIssueReport(api, SLUG, "body", true);
    expect(result).toEqual({ url: "https://github.com/o/private-repo/issues/3" });
    expect(api.calls.some((c) => `${c.method} ${c.path}` === ISSUE_CREATE)).toBe(false);
  });

  test("the creator scan early-exits once a page contains the issue", async () => {
    const filler = Array.from({ length: 100 }, (_, i) => ({
      number: 100 + i,
      title: i === 50 ? ISSUE_TITLE : `noise ${i}`,
      state: "closed",
      html_url: `https://github.com/o/private-repo/issues/${100 + i}`,
    }));
    const api = new MockApi({
      [LABEL_CREATE]: { data: MARKER_LABEL_CONFIG },
      [LABEL_LOOKUP]: { data: [] },
      "GET /user": { data: { login: "bot" } },
      [CREATOR_SCAN]: { data: filler },
      "PATCH /repos/o/private-repo/issues/150": { data: null },
    });
    const result = await deliverIssueReport(api, SLUG, "body", true);
    expect(result).toEqual({ url: "https://github.com/o/private-repo/issues/150" });
    // A full page came back, but the match stops the walk: no page=2 request.
    expect(api.calls.filter((c) => c.path.includes("page=2"))).toHaveLength(0);
  });

  test("nothing anywhere: POST with the marker label, then close when healthy", async () => {
    const api = new MockApi({
      [LABEL_CREATE]: { data: MARKER_LABEL_CONFIG },
      [LABEL_LOOKUP]: { data: [] },
      "GET /user": { data: { login: "bot" } },
      [CREATOR_SCAN]: { data: [] },
      [ISSUE_CREATE]: { data: reportIssue(9) },
      "PATCH /repos/o/private-repo/issues/9": { data: null },
    });
    const result = await deliverIssueReport(api, SLUG, "body", false);
    expect(result).toEqual({ url: "https://github.com/o/private-repo/issues/9" });
    const scanAt = api.calls.findIndex((c) => `${c.method} ${c.path}` === CREATOR_SCAN);
    const createAt = api.calls.findIndex((c) => `${c.method} ${c.path}` === ISSUE_CREATE);
    expect(scanAt).toBeGreaterThanOrEqual(0);
    expect(scanAt).toBeLessThan(createAt);
    const close = api.calls.find((c) => c.method === "PATCH");
    expect(close?.payload).toEqual({ state: "closed" });
  });

  test("a needs-attention first run creates the issue and leaves it open", async () => {
    const api = new MockApi({
      [LABEL_CREATE]: { data: MARKER_LABEL_CONFIG },
      [LABEL_LOOKUP]: { data: [] },
      "GET /user": { data: { login: "bot" } },
      [CREATOR_SCAN]: { data: [] },
      [ISSUE_CREATE]: { data: reportIssue(9) },
    });
    const result = await deliverIssueReport(api, SLUG, "body", true);
    expect(result).toEqual({ url: "https://github.com/o/private-repo/issues/9" });
    expect(api.calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  test("a denied marker-label create is a safe warning and stops everything", async () => {
    const api = new MockApi({
      [LABEL_CREATE]: {
        error: { status: 403, message: "Resource not accessible for o/private-repo", body: "" },
      },
    });
    const result = await deliverIssueReport(api, SLUG, "body", true);
    if (!("warning" in result)) {
      throw new Error("expected a warning");
    }
    expect(result.warning).toContain("HTTP 403");
    expect(result.warning).toContain('"Issues" (read and write)');
    expect(result.warning).not.toContain(SLUG);
    expect(api.calls).toHaveLength(1);
  });

  test("a non-permission failure gets re-run advice, no grant prose", async () => {
    const api = new MockApi({
      [LABEL_CREATE]: { error: { status: 422, message: "already_exists", body: "" } },
      [LABEL_LOOKUP]: { data: [reportIssue(7)] },
      "PATCH /repos/o/private-repo/issues/7": {
        error: { status: 500, message: "boom o/private-repo", body: "" },
      },
    });
    const result = await deliverIssueReport(api, SLUG, "body", true);
    if (!("warning" in result)) {
      throw new Error("expected a warning");
    }
    expect(result.warning).toContain("HTTP 500");
    expect(result.warning).toContain("Re-run the workflow");
    expect(result.warning).not.toContain("Issues");
    expect(result.warning).not.toContain(SLUG);
  });

  test("a throwing transport never escapes; the warning stays slug-free", async () => {
    // MockApi throws on unrouted mutations, standing in for a network-level
    // failure (GithubApi throws those with the path in the message).
    const api = new MockApi({});
    const result = await deliverIssueReport(api, SLUG, "body", true);
    if (!("warning" in result)) {
      throw new Error("expected a warning");
    }
    expect(result.warning).toContain("could not deliver the private report");
    expect(result.warning).not.toContain(SLUG);
  });

  test("a non-list lookup response is a warning, not a crash", async () => {
    const api = new MockApi({
      [LABEL_CREATE]: { error: { status: 422, message: "already_exists", body: "" } },
      [LABEL_LOOKUP]: { data: { message: "unexpected" } },
    });
    const result = await deliverIssueReport(api, SLUG, "body", true);
    if (!("warning" in result)) {
      throw new Error("expected a warning");
    }
    expect(result.warning).toContain("unexpected shape");
  });
});

describe("injectMarkerLabel", () => {
  test("appends the marker to a declared labels section without mutating the input", () => {
    const settings: SettingsFile = { labels: [{ name: "bug", color: "d73a4a" }] };
    const { settings: injected, injected: didInject } = injectMarkerLabel(settings);
    expect(didInject).toBe(true);
    expect(injected.labels).toEqual([{ name: "bug", color: "d73a4a" }, MARKER_LABEL_CONFIG]);
    expect(settings.labels).toHaveLength(1);
  });

  test("an already-declared marker (any case) is left alone", () => {
    const settings: SettingsFile = { labels: [{ name: "Settings-As-Code-Report" }] };
    const result = injectMarkerLabel(settings);
    expect(result.injected).toBe(false);
    expect(result.settings).toBe(settings);
  });

  test("a rename resolving to the marker counts as declared", () => {
    const settings: SettingsFile = { labels: [{ name: "old-report", new_name: MARKER_LABEL }] };
    expect(injectMarkerLabel(settings).injected).toBe(false);
  });

  test("a rename moving the marker AWAY is refused (new_name stripped), not injected", () => {
    // Renaming the marker to another name would break the next run's lookup by
    // the constant marker name, so the rename is dropped and flagged.
    const settings: SettingsFile = {
      labels: [{ name: MARKER_LABEL, new_name: "something-else", color: "0e2a47" }],
    };
    const result = injectMarkerLabel(settings);
    expect(result.injected).toBe(false);
    expect(result.renameRefused).toBe(true);
    // the entry survives but its new_name is gone, so the marker keeps its name
    expect(result.settings.labels).toEqual([
      { name: MARKER_LABEL, new_name: undefined, color: "0e2a47" },
    ]);
    // input is not mutated
    const original = settings.labels?.[0] as { new_name?: string } | undefined;
    expect(original?.new_name).toBe("something-else");
  });

  test("a rename to the marker (case-insensitive) is NOT treated as moving it away", () => {
    const settings: SettingsFile = {
      labels: [{ name: MARKER_LABEL, new_name: "Settings-As-Code-Report" }],
    };
    const result = injectMarkerLabel(settings);
    expect(result.renameRefused).toBe(false);
    expect(result.injected).toBe(false);
  });

  test("no labels section means nothing to inject", () => {
    const settings: SettingsFile = { repository: { has_wiki: false } };
    const result = injectMarkerLabel(settings);
    expect(result.injected).toBe(false);
    expect(result.settings).toBe(settings);
  });
});
