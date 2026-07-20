import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("bundle freshness", () => {
  test("lib/index.js matches a fresh build of src/", async () => {
    const root = join(import.meta.dir, "..");
    const build = await Bun.build({
      entrypoints: [join(root, "src/main.ts")],
      target: "node",
    });
    expect(build.success).toBe(true);
    const fresh = await build.outputs[0]?.text();
    const committed = readFileSync(join(root, "lib/index.js"), "utf8");
    expect(committed).toBe(fresh ?? "");
  });
});
