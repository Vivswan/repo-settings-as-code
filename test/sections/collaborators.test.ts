import { describe, expect, test } from "bun:test";
import { collaboratorsSection } from "../../src/sections/collaborators.js";
import { MockApi } from "../mock-api.js";
import { ctx } from "./context.js";

describe("collaborators", () => {
  test("collaborator push matches live role_name write", async () => {
    const api = new MockApi({
      "GET /repos/o/r/collaborators?affiliation=direct&per_page=100&page=1": {
        data: [{ login: "alice", role_name: "write" }],
      },
    });
    const result = await collaboratorsSection.run(ctx(api, true), [
      { username: "alice", permission: "push" },
    ]);
    expect(result.drift).toEqual([]);
  });
});
