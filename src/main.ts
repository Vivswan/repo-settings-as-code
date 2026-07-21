/**
 * Bundled entrypoint (lib/index.js is built from this file): run the
 * action and map its return code to the process exit code. Everything
 * else lives in src/action/.
 */

import { annotate } from "./action/io.js";
import { run } from "./action/run.js";

const invokedDirectly =
  process.argv[1]?.endsWith("main.ts") || process.argv[1]?.endsWith("index.js");
if (invokedDirectly) {
  run().then(
    (code) => process.exit(code),
    (error) => {
      annotate(
        "error",
        `repo-settings-as-code stopped unexpectedly: ${String(error)}. Re-run the workflow; if it recurs, report a bug with this log attached`,
      );
      process.exit(1);
    },
  );
}
