import { describe, expect, test } from "bun:test";
import { applyDefaults, deepMerge } from "../../src/engine/merge.js";
import type { SettingsFile } from "../../src/schema.js";

describe("deepMerge", () => {
  test("objects merge recursively, override keys win", () => {
    const base = { repository: { has_wiki: false, description: "base" } };
    const override = { repository: { description: "mine" }, labels: [{ name: "bug" }] };
    expect(deepMerge(base, override)).toEqual({
      repository: { has_wiki: false, description: "mine" },
      labels: [{ name: "bug" }],
    });
  });

  test("arrays and scalars replace, never concatenate", () => {
    const base = { labels: [{ name: "a" }, { name: "b" }], repository: { topics: "x, y" } };
    const override = { labels: [{ name: "c" }], repository: { topics: "z" } };
    expect(deepMerge(base, override)).toEqual({
      labels: [{ name: "c" }],
      repository: { topics: "z" },
    });
  });

  test("nested null replaces the base value", () => {
    const merged = deepMerge(
      { branches: [{ name: "main", protection: { enforce_admins: true } }] },
      { branches: [{ name: "main", protection: null }] },
    ) as { branches: Array<{ protection: unknown }> };
    expect(merged.branches[0]?.protection).toBeNull();
  });

  test("never mutates its inputs", () => {
    const base = { repository: { has_wiki: false } };
    const override = { repository: { has_issues: true } };
    const merged = deepMerge(base, override) as { repository: Record<string, unknown> };
    merged.repository.has_wiki = true;
    expect(base.repository.has_wiki).toBe(false);
    expect(override).toEqual({ repository: { has_issues: true } });
  });
});

describe("applyDefaults", () => {
  test("top-level null section is stripped and reported as disabled", () => {
    const defaults = { labels: [{ name: "bug", color: "d73a4a" }] } as SettingsFile;
    const repo = { labels: null, repository: { has_wiki: false } } as unknown as SettingsFile;
    const { settings, disabled } = applyDefaults(defaults, repo);
    expect(disabled).toEqual(["labels"]);
    expect("labels" in settings).toBe(false);
    expect(settings.repository).toEqual({ has_wiki: false });
  });

  test("empty defaults leave the repo settings untouched", () => {
    const repo = { repository: { has_wiki: false } } as SettingsFile;
    const { settings, disabled } = applyDefaults({}, repo);
    expect(settings).toEqual(repo);
    expect(disabled).toEqual([]);
  });

  test("a null section the defaults do not declare passes through", () => {
    const defaults = { repository: { has_wiki: false } } as SettingsFile;
    const repo = { pages: null } as SettingsFile;
    const { settings, disabled } = applyDefaults(defaults, repo);
    expect(settings.pages).toBeNull();
    expect(disabled).toEqual([]);
  });

  test("a null section the defaults declare non-null is still an opt-out", () => {
    const defaults = { pages: { build_type: "workflow" } } as SettingsFile;
    const repo = { pages: null } as SettingsFile;
    const { settings, disabled } = applyDefaults(defaults, repo);
    expect("pages" in settings).toBe(false);
    expect(disabled).toEqual(["pages"]);
  });

  test("a null section in the defaults themselves passes through to every target", () => {
    const defaults = { pages: null } as SettingsFile;
    const { settings, disabled } = applyDefaults(defaults, {} as SettingsFile);
    expect(settings.pages).toBeNull();
    expect(disabled).toEqual([]);
  });
});
