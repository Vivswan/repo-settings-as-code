/**
 * The output port every layer reports through: workflow annotations and
 * log lines. Defined at the root so the engine (which calls it) and the
 * action layer (which implements it over @actions/core) share one
 * contract without importing each other.
 */
export interface Io {
  annotate(level: "notice" | "warning" | "error", message: string): void;
  log(line: string): void;
}
