import { inflateSync } from "node:zlib";

/** Unwrap WOFF1 tables as SFNT before PDF embedding; keep the font tables intact. */
export function woffToSfnt(input) {
  if (input.readUInt32BE(0) !== 0x774f4646)
    throw new Error("Expected a WOFF1 font");
  const count = input.readUInt16BE(12);
  const output = Buffer.alloc(input.readUInt32BE(16));
  output.writeUInt32BE(input.readUInt32BE(4), 0);
  output.writeUInt16BE(count, 4);
  const selector = Math.floor(Math.log2(count));
  output.writeUInt16BE(16 * 2 ** selector, 6);
  output.writeUInt16BE(selector, 8);
  output.writeUInt16BE(count * 16 - 16 * 2 ** selector, 10);
  let offset = 12 + count * 16;
  let head = -1;
  for (let i = 0; i < count; i++) {
    const source = 44 + i * 20;
    const target = 12 + i * 16;
    const tag = input.toString("ascii", source, source + 4);
    const start = input.readUInt32BE(source + 4);
    const packed = input.readUInt32BE(source + 8);
    const length = input.readUInt32BE(source + 12);
    const bytes = input.subarray(start, start + packed);
    const table = packed < length ? inflateSync(bytes) : bytes;
    if (table.length !== length || offset + length > output.length)
      throw new Error("Invalid WOFF table");
    input.copy(output, target, source, source + 4);
    output.writeUInt32BE(input.readUInt32BE(source + 16), target + 4);
    output.writeUInt32BE(offset, target + 8);
    output.writeUInt32BE(length, target + 12);
    table.copy(output, offset);
    if (tag === "head") head = offset;
    offset += (length + 3) & ~3;
  }
  if (head < 0 || offset !== output.length)
    throw new Error("Invalid SFNT size");
  output.writeUInt32BE(0, head + 8);
  let checksum = 0;
  for (let i = 0; i < output.length; i += 4)
    checksum = (checksum + output.readUInt32BE(i)) >>> 0;
  output.writeUInt32BE((0xb1b0afba - checksum) >>> 0, head + 8);
  return output;
}
