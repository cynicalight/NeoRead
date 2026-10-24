import { expect, it } from "vitest";
import { consumeCiteEvents, type CiteEvent } from "./cite-events";

function stream(chunks: string[]) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

it("dispatches commands split across chunks and skips unknown events", async () => {
  const events: CiteEvent[] = [];
  await consumeCiteEvents(
    stream([
      ": ready\n\n",
      'event: command\ndata: {"type":"command","transaction":"t","comm',
      'and":"refresh","documentId":"d","client":"wps"}\n\n',
      'event: other\ndata: {"type":"other"}\n\n',
      'event: focus\ndata: {"type":"focus"}\n\n',
    ]),
    new AbortController().signal,
    (event) => events.push(event),
  );
  expect(events).toEqual([
    {
      type: "command",
      transaction: "t",
      command: "refresh",
      documentId: "d",
      client: "wps",
    },
    { type: "focus" },
  ]);
});
