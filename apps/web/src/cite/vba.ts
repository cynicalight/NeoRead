import type { Operation, Run } from "./protocol";

/**
 * Word's VBA has no JSON parser (and no Dictionary on macOS), so operations
 * for Word also carry this line format: one record per line, fields separated
 * by tabs, with "\\", tab, CR and LF escaped as \\ \t \r \n.
 *
 *   op      <name>
 *   kind    citation|bibliography      noteType <0|1|2>
 *   data    <text>
 *   keepText <0|1>                     index <n>   (descending)
 *   field <n>, then: code <text> · text · bibliography <hanging> <align>
 *     <maxOffset> <lineSpacing> <entrySpacing> · para · run <flags> <text> · end
 *
 * Run flags: i italic, b bold, u underline, ^ superscript, _ subscript,
 * c small caps.
 */
export const escapeVBA = (value: string) =>
  value
    .replace(/\\/g, "\\\\")
    .replace(/\t/g, "\\t")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");

const line = (...parts: (string | number)[]) =>
  parts.map((p) => escapeVBA(String(p))).join("\t");

function runs(list: Run[]) {
  return list.map((run) =>
    line(
      "run",
      [
        run.i && "i",
        run.b && "b",
        run.u && "u",
        run.sup && "^",
        run.sub && "_",
        run.sc && "c",
      ]
        .filter(Boolean)
        .join(""),
      run.text,
    ),
  );
}

export function encodeForVBA(operation: Operation): string {
  const lines = [line("op", operation.op)];
  switch (operation.op) {
    case "Document.insertField":
      lines.push(
        line("kind", operation.kind),
        line("noteType", operation.noteType),
      );
      break;
    case "Document.setData":
      lines.push(line("data", operation.data));
      break;
    case "Document.removeFields":
      lines.push(line("keepText", operation.keepText ? 1 : 0));
      for (const index of [...operation.indexes].sort((a, b) => b - a))
        lines.push(line("index", index));
      break;
    case "Document.updateFields":
      for (const update of operation.updates) {
        lines.push(line("field", update.index));
        if (update.code !== undefined) lines.push(line("code", update.code));
        if (update.text) lines.push(line("text"), ...runs(update.text));
        if (update.bibliography) {
          const { entries, format } = update.bibliography;
          lines.push(
            line(
              "bibliography",
              format.hangingIndent ? 1 : 0,
              format.secondFieldAlign || "none",
              format.maxOffset,
              format.lineSpacing,
              format.entrySpacing,
            ),
          );
          entries.forEach((entry, i) => {
            if (i) lines.push(line("para"));
            lines.push(...runs(entry));
          });
        }
        lines.push(line("end"));
      }
      break;
  }
  return lines.join("\n");
}
