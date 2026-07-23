/**
 * The `artifact` private-report channel: the concatenated report document,
 * age-encrypted to an operator-held recipient and uploaded as a workflow
 * artifact on the (public) run. Access control is key possession - for
 * readers who hold the private key but have no GitHub access to the
 * targets. Crypto comes from the `age-encryption` package (typage, by
 * age's author); nothing here rolls its own primitives. The upload sits
 * behind a small injectable port so composition and encryption are
 * unit-testable without the artifact service.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultArtifactClient } from "@actions/artifact";
import { Encrypter } from "age-encryption";

export const ARTIFACT_NAME = "settings-as-code-private-report";
export const ARTIFACT_FILE = "private-report.md.age";

/**
 * Validate an age recipient string without encrypting anything, for reuse
 * at config parse: a malformed `report-public-key` must be rejected before
 * any API work. Accepts exactly what the age library accepts (`age1...`).
 */
export function parseRecipient(recipient: string): { ok: true } | { ok: false; error: string } {
  try {
    new Encrypter().addRecipient(recipient);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Encrypt the report document to the operator's age recipient. Decrypt
 * locally with `age -d -i key.txt private-report.md.age`.
 */
export async function encryptReport(recipient: string, content: string): Promise<Uint8Array> {
  const encrypter = new Encrypter();
  encrypter.addRecipient(recipient);
  return encrypter.encrypt(content);
}

/** The upload port, injectable so tests never touch the artifact service. */
export interface ArtifactUploader {
  upload(name: string, file: { name: string; data: Uint8Array }): Promise<void>;
}

/**
 * The production port: @actions/artifact uploads files from disk, so the
 * ciphertext takes a round trip through a private temp directory.
 */
const actionsUploader: ArtifactUploader = {
  async upload(name, file) {
    // DefaultArtifactClient emits its own core.warning before it throws on a
    // missing runtime token, so invoking it without one would double-warn.
    // Fail before constructing it; deliverArtifactReport turns this into the
    // single warning callers see.
    if (!process.env.ACTIONS_RUNTIME_TOKEN) {
      throw new Error(
        "the artifact service is unavailable: no ACTIONS_RUNTIME_TOKEN in the environment. Artifact upload needs a GitHub-hosted or self-hosted Actions runner (it is not available on GitHub Enterprise Server or outside Actions)",
      );
    }
    const dir = await mkdtemp(join(tmpdir(), "settings-as-code-report-"));
    try {
      const path = join(dir, file.name);
      await writeFile(path, file.data);
      await new DefaultArtifactClient().uploadArtifact(name, [path], dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
};

export type ArtifactDelivery = { uploaded: true } | { warning: string };

/**
 * Encrypt the document and upload it as the report artifact. Never throws:
 * report delivery is auxiliary, so a missing runtime token, an artifact
 * service failure, or a bad recipient comes back as a warning and the
 * run's result stays untouched. The thrown messages describe the artifact
 * service or the recipient - never the report content, which only ever
 * leaves this module as ciphertext.
 */
export async function deliverArtifactReport(
  document: string,
  recipient: string,
  uploader: ArtifactUploader = actionsUploader,
): Promise<ArtifactDelivery> {
  try {
    const ciphertext = await encryptReport(recipient, document);
    await uploader.upload(ARTIFACT_NAME, { name: ARTIFACT_FILE, data: ciphertext });
    return { uploaded: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      warning: `could not upload the private report artifact: ${reason}. Re-run the workflow, or set private-report: none if it persists`,
    };
  }
}
