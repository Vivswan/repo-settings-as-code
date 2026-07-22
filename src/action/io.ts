/**
 * The Io implementation over @actions/core: workflow annotations, action
 * outputs, and plain log lines.
 */

import * as core from "@actions/core";
import type { Io } from "../io.js";

/**
 * Every action output name run() writes, and the single source the
 * action.yml `outputs` block is pinned against. Typing setOutput's `name`
 * to this union makes a typo at a call site a compile error.
 */
export const OUTPUT_NAMES = ["result", "skipped-sections", "repos-result"] as const;

export function annotate(level: "notice" | "warning" | "error", message: string): void {
  // @actions/core owns workflow-command escaping (%, CR, LF).
  core[level](message);
}

export function setOutput(name: (typeof OUTPUT_NAMES)[number], value: string): void {
  // Guarded: the runner always sets GITHUB_OUTPUT; local/test runs may not.
  if (process.env.GITHUB_OUTPUT) {
    core.setOutput(name, value);
  }
}

/** The production Io sink: annotations via the runner, logs to stdout. */
export const actionsIo: Io = { annotate, log: (line) => console.log(line) };
