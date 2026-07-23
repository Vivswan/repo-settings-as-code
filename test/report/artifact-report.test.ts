import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as core from "@actions/core";
import { Decrypter, generateX25519Identity, identityToRecipient } from "age-encryption";
import {
  ARTIFACT_FILE,
  ARTIFACT_NAME,
  type ArtifactUploader,
  deliverArtifactReport,
  encryptReport,
  parseRecipient,
} from "../../src/report/artifact-report.js";

async function testKeypair(): Promise<{ identity: string; recipient: string }> {
  const identity = await generateX25519Identity();
  return { identity, recipient: await identityToRecipient(identity) };
}

function captureUploader(): {
  uploader: ArtifactUploader;
  uploads: Array<{ name: string; file: { name: string; data: Uint8Array } }>;
} {
  const uploads: Array<{ name: string; file: { name: string; data: Uint8Array } }> = [];
  return {
    uploader: {
      async upload(name, file) {
        uploads.push({ name, file });
      },
    },
    uploads,
  };
}

describe("encryptReport", () => {
  test("round-trips through the age library's own decrypter", async () => {
    const { identity, recipient } = await testKeypair();
    const ciphertext = await encryptReport(recipient, "the private report body");
    expect(ciphertext).not.toContain(new TextEncoder().encode("private"));
    const decrypter = new Decrypter();
    decrypter.addIdentity(identity);
    expect(await decrypter.decrypt(ciphertext, "text")).toBe("the private report body");
  });
});

describe("parseRecipient", () => {
  test("accepts a generated age recipient", async () => {
    const { recipient } = await testKeypair();
    expect(parseRecipient(recipient)).toEqual({ ok: true });
  });

  test.each([
    "",
    "not-a-key",
    "age1shortandinvalid",
    "AGE-SECRET-KEY-1NOTPUBLIC",
  ])("rejects a malformed recipient: %j", (recipient) => {
    const result = parseRecipient(recipient);
    expect(result.ok).toBe(false);
  });
});

describe("deliverArtifactReport", () => {
  test("hands the uploader port ciphertext under the fixed artifact names", async () => {
    const { identity, recipient } = await testKeypair();
    const { uploader, uploads } = captureUploader();
    const result = await deliverArtifactReport("secret document", recipient, uploader);
    expect(result).toEqual({ uploaded: true });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.name).toBe(ARTIFACT_NAME);
    expect(uploads[0]?.file.name).toBe(ARTIFACT_FILE);
    // The port only ever sees ciphertext, and it decrypts back to the document.
    const data = uploads[0]?.file.data as Uint8Array;
    expect(new TextDecoder().decode(data)).not.toContain("secret document");
    const decrypter = new Decrypter();
    decrypter.addIdentity(identity);
    expect(await decrypter.decrypt(data, "text")).toBe("secret document");
  });

  test("an upload failure is a warning, never a throw", async () => {
    const { recipient } = await testKeypair();
    const uploader: ArtifactUploader = {
      async upload() {
        throw new Error("Unable to get the ACTIONS_RUNTIME_TOKEN env variable");
      },
    };
    const result = await deliverArtifactReport("doc", recipient, uploader);
    if (!("warning" in result)) {
      throw new Error("expected a warning");
    }
    expect(result.warning).toContain("could not upload the private report artifact");
    expect(result.warning).toContain("ACTIONS_RUNTIME_TOKEN");
  });

  test("a malformed recipient is a warning and the uploader is never called", async () => {
    const { uploader, uploads } = captureUploader();
    const result = await deliverArtifactReport("doc", "not-a-key", uploader);
    expect("warning" in result).toBe(true);
    expect(uploads).toHaveLength(0);
  });
});

describe("default uploader without a runtime token", () => {
  const savedToken = process.env.ACTIONS_RUNTIME_TOKEN;

  afterEach(() => {
    if (savedToken === undefined) {
      delete process.env.ACTIONS_RUNTIME_TOKEN;
    } else {
      process.env.ACTIONS_RUNTIME_TOKEN = savedToken;
    }
  });

  test("missing token yields exactly ONE warning and never invokes the artifact client", async () => {
    delete process.env.ACTIONS_RUNTIME_TOKEN;
    // DefaultArtifactClient emits its OWN core.warning before throwing, so a
    // double-warning would show up as extra core.warning calls. The guard must
    // return our single warning without ever reaching the client.
    const warnSpy = spyOn(core, "warning").mockImplementation(() => {});
    try {
      const { recipient } = await testKeypair();
      const result = await deliverArtifactReport("secret document", recipient);

      // exactly one warning, and it is ours (the client's own text never appears)
      if (!("warning" in result)) {
        throw new Error("expected a warning");
      }
      expect(result.warning).toContain("could not upload the private report artifact");
      expect(result.warning).toContain("ACTIONS_RUNTIME_TOKEN");
      // the client was never reached, so it emitted no core.warning of its own
      expect(warnSpy).toHaveBeenCalledTimes(0);
      // and no report content ever leaves the module
      expect(result.warning).not.toContain("secret document");
    } finally {
      warnSpy.mockRestore();
    }
  });
});
