import { afterEach, describe, expect, test } from "bun:test";
import { getRepoFile } from "../../src/github/repo-file.js";
import { api, restoreFetch, stubFetch } from "./stub.js";

afterEach(restoreFetch);

describe("getRepoFile 404 disambiguation", () => {
  const notFound = () => new Response('{"message":"Not Found"}', { status: 404 });
  const repoWithPull = () =>
    new Response('{"permissions":{"pull":true}}', {
      headers: { "content-type": "application/json" },
    });
  const repoWithoutPull = () =>
    new Response('{"permissions":{"pull":false}}', {
      headers: { "content-type": "application/json" },
    });

  test("contents 404 with readable contents means the file is missing", async () => {
    const state = stubFetch([notFound, repoWithPull]);
    const result = await getRepoFile(api(), "o/r", ".github/settings.yml");
    expect(state.calls).toBe(2);
    expect("missing" in result).toBe(true);
  });

  test("contents 404 without Contents access is an error, not a missing file", async () => {
    stubFetch([notFound, repoWithoutPull]);
    const result = await getRepoFile(api(), "o/r", ".github/settings.yml");
    expect("error" in result && result.error.message).toContain("Contents");
  });

  test("contents 404 with an invisible repo surfaces the repo-level error", async () => {
    stubFetch([notFound, notFound]);
    const result = await getRepoFile(api(), "o/r", ".github/settings.yml");
    expect("error" in result && result.error.status).toBe(404);
  });

  test("a found file never triggers the repo probe", async () => {
    const state = stubFetch([() => new Response("labels: []\n")]);
    const result = await getRepoFile(api(), "o/r", ".github/settings.yml");
    expect(state.calls).toBe(1);
    expect("content" in result && result.content).toBe("labels: []\n");
  });
});
