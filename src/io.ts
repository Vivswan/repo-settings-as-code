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

/**
 * Wrap an Io so every annotation and log line is prefixed with `prefix`.
 * An empty prefix returns the sink unchanged.
 */
export function prefixedIo(io: Io, prefix: string): Io {
  if (prefix === "") {
    return io;
  }
  return {
    annotate: (level, message) => io.annotate(level, `${prefix}${message}`),
    log: (line) => io.log(`${prefix}${line}`),
  };
}
