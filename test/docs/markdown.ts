/**
 * Small markdown helpers shared by the docs contract tests: pull the lines of
 * a named "## heading" section, and parse a markdown table's body rows into
 * trimmed cells. Kept forgiving of column widths so a reflowed table does not
 * break the tests over whitespace.
 */

/** The lines of a markdown section between `## <heading>` and the next `## `. */
export function sectionLines(markdown: string, heading: string): string[] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) {
    throw new Error(`no "## ${heading}" section found`);
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * Parse a markdown table's body rows (skipping the header and the |---| rule)
 * into arrays of trimmed cells.
 */
export function tableRows(lines: string[]): string[][] {
  return lines
    .filter((line) => line.trim().startsWith("|"))
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    )
    .filter((cells) => cells.length > 0 && !/^-+$/.test(cells[0] ?? ""))
    .filter((cells) => cells[0] !== "Section" && cells[0] !== "Area" && cells[0] !== "Input");
}
