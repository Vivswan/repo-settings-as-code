/**
 * The Io implementation over @actions/core: workflow annotations, action
 * outputs, and plain log lines.
 */

import * as core from "@actions/core";
import type { Io } from "../io.js";

export function annotate(level: "notice" | "warning" | "error", message: string): void {
  // @actions/core owns workflow-command escaping (%, CR, LF).
  core[level](message);
}

export function setOutput(name: string, value: string): void {
  // Guarded: the runner always sets GITHUB_OUTPUT; local/test runs may not.
  if (process.env.GITHUB_OUTPUT) {
    core.setOutput(name, value);
  }
}

/** The production Io sink: annotations via the runner, logs to stdout. */
export const actionsIo: Io = { annotate, log: (line) => console.log(line) };
