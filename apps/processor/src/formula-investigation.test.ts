import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { extractTextSpans } from "./text";
import { assignText } from "./layout";

it("keeps inline formulas on their own lines in the Transformer paper", async () => {
  const task = getDocument({
    data: new Uint8Array(
      await readFile(
        new URL(
          "../../server/internal/neoread/example-paper/paper.pdf",
          import.meta.url,
        ),
      ),
    ),
    useSystemFonts: true,
  });
  try {
    const pdf = await task.promise;
    const extract = async (
      number: number,
      bounds: { x: number; y: number; width: number; height: number },
    ) =>
      assignText(
        [{ label: "text", confidence: 1, order: 0, bounds }],
        await extractTextSpans(await pdf.getPage(number), 2),
      ).texts[0];
    const recurrent = await extract(2, {
      x: 0.1708984375,
      y: 0.19970703125,
      width: 0.65673828125,
      height: 0.11181640625,
    });
    expect(recurrent).toContain(
      "states h t , as a function of the previous hidden state h t − 1 and the input for position t . This inherently",
    );
    const attention = await extract(4, {
      x: 0.17041015625,
      y: 0.4651336669921875,
      width: 0.65673828125,
      height: 0.056549072265625,
    });
    expect(attention).toContain(
      "keys of dimension d k , and values of dimension d v . We compute",
    );
    expect(attention).toContain(
      "query with all keys, divide each by √ d k , and apply a softmax",
    );
  } finally {
    await task.destroy();
  }
});
