import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { beforeAll, expect, test } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
beforeAll(() => execFileSync(process.execPath, ["build.mjs"], { cwd: root }));

test("SDK worker bridges only registered tools and resumes accepted history", async () => {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const hasTool = body.messages.some((m: any) => m.role === "tool");
    const delta = hasTool
      ? { content: "原文是 42 [S1]。" }
      : {
          tool_calls: [
            {
              index: 0,
              id: "read-1",
              type: "function",
              function: { name: "read_passage", arguments: '{"full":true}' },
            },
          ],
        };
    for (const choice of [
      { delta, finish_reason: null },
      { delta: {}, finish_reason: hasTool ? "stop" : "tool_calls" },
    ])
      res.write(
        `data: ${JSON.stringify({ id: "completion", object: "chat.completion.chunk", model: "neoread-test", choices: [{ index: 0, ...choice }] })}\n\n`,
      );
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const input = {
    version: 1,
    runId: "test",
    key: "",
    effort: "off",
    prompt: "读原文",
    system: "只读当前论文",
    model: {
      id: "neoread-test",
      name: "neoread-test",
      provider: "neoread",
      api: "openai-completions",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32000,
      maxTokens: 4096,
    },
    tools: [
      {
        name: "read_passage",
        description: "read text",
        schema: {
          type: "object",
          properties: { full: { type: "boolean" } },
          required: ["full"],
        },
      },
    ],
  };
  async function run(entries?: unknown[]) {
    const child = spawn(process.execPath, ["dist/main.mjs"], { cwd: root });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const events: any[] = [];
    createInterface({ input: child.stdout }).on("line", (line) => {
      const event = JSON.parse(line);
      events.push(event);
      if (event.type === "tool")
        child.stdin.write(
          JSON.stringify({
            type: "toolResult",
            runId: "test",
            id: event.id,
            content: [{ type: "text", text: "[S1] 原文是42" }],
          }) + "\n",
        );
    });
    child.stdin.write(
      JSON.stringify({ type: "start", input: { ...input, entries } }) + "\n",
    );
    const code = await new Promise((resolve) => child.on("exit", resolve));
    expect({
      code,
      stderr,
      error: events.find((e) => e.type === "error"),
    }).toEqual({ code: 0, stderr: "", error: undefined });
    return events;
  }
  try {
    const events = await run();
    expect(
      events.some((e) => e.type === "draft" && e.text.includes("42")),
    ).toBe(true);
    expect(events.filter((e) => e.type === "tool")).toHaveLength(1);
    const complete = events.at(-1);
    expect(complete.type).toBe("complete");
    expect(complete.entries.some((e: any) => e.type === "message")).toBe(true);
    const resumed = await run(complete.entries);
    expect(resumed.filter((e) => e.type === "tool")).toHaveLength(0);
    expect(requests[0].tools.map((t: any) => t.function.name)).toEqual([
      "read_passage",
    ]);
    expect(
      requests.at(-1).messages.filter((m: any) => m.role === "user").length,
    ).toBe(2);
  } finally {
    server.close();
    server.closeAllConnections();
  }
}, 20000);

test.each(["truncated", "anthropic"])(
  "validates %s provider termination",
  async (mode) => {
    const upstream = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const request = JSON.parse(raw);
      expect(request.messages.at(-1).content).toBeTruthy();
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (mode === "truncated") {
        res.end(
          'data: {"choices":[{"index":0,"delta":{"content":"partial answer"}}]}\n\n',
        );
        return;
      }
      expect(req.url).toBe("/relay/messages");
      for (const [event, data] of [
        [
          "message_start",
          {
            type: "message_start",
            message: {
              id: "m",
              type: "message",
              role: "assistant",
              model: "test",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 10, output_tokens: 0 },
            },
          },
        ],
        [
          "content_block_start",
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
        ],
        [
          "content_block_delta",
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "anthropic complete" },
          },
        ],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        [
          "message_delta",
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 4 },
          },
        ],
        ["message_stop", { type: "message_stop" }],
      ])
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      res.end();
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    const base = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/relay`;
    const child = spawn(process.execPath, ["dist/main.mjs"], { cwd: root });
    const events: any[] = [];
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    createInterface({ input: child.stdout }).on("line", (line) =>
      events.push(JSON.parse(line)),
    );
    child.stdin.write(
      JSON.stringify({
        type: "start",
        input: {
          version: 1,
          runId: "protocol",
          prompt: "hello",
          system: "read",
          key: "",
          effort: "off",
          tools: [],
          endpoint:
            base + (mode === "anthropic" ? "/messages" : "/chat/completions"),
          payload: mode === "anthropic" ? { max_tokens: 8192 } : {},
          model: {
            id: "test",
            name: "test",
            provider: "neoread",
            api:
              mode === "anthropic"
                ? "anthropic-messages"
                : "openai-completions",
            baseUrl: base,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 32000,
            maxTokens: 4096,
          },
        },
      }) + "\n",
    );
    try {
      const code = await new Promise((resolve) => child.on("exit", resolve));
      expect(stderr).toBe("");
      if (mode === "truncated") {
        expect(code).toBe(1);
        expect(
          events.some((e) => e.type === "draft" && e.text === "partial answer"),
        ).toBe(true);
        expect(events.some((e) => e.type === "complete")).toBe(false);
      } else {
        expect({ code, error: events.find((e) => e.type === "error") }).toEqual(
          { code: 0, error: undefined },
        );
        expect(events.at(-1).text).toBe("anthropic complete");
      }
    } finally {
      child.kill();
      upstream.close();
      upstream.closeAllConnections();
    }
  },
  15000,
);

// These fixtures exercise the packaged worker and the real Pi Responses adapter.
function responseEvents(output: any, terminal = "completed", totalTokens = 15) {
  const events: any[] = [
    {
      type: "response.created",
      response: { id: "resp_fixture", status: "in_progress" },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...output, content: [], arguments: "" },
    },
  ];
  if (output.type === "message")
    events.push({
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      item_id: output.id,
      delta: output.content[0].text,
    });
  else
    events.push({
      type: "response.function_call_arguments.delta",
      output_index: 0,
      item_id: output.id,
      delta: output.arguments,
    });
  events.push({
    type: "response.output_item.done",
    output_index: 0,
    item: output,
  });
  if (terminal !== "truncated")
    events.push({
      type:
        terminal === "failed"
          ? "response.failed"
          : terminal === "incomplete"
            ? "response.incomplete"
            : "response.completed",
      response: {
        id: "resp_fixture",
        status: terminal === "missing-status" ? undefined : terminal,
        output: [output],
        usage: {
          input_tokens: totalTokens - 5,
          output_tokens: 5,
          total_tokens: totalTokens,
        },
        ...(terminal === "failed"
          ? { error: { code: "server_error", message: "fixture failure" } }
          : {}),
        ...(terminal === "incomplete"
          ? { incomplete_details: { reason: "max_output_tokens" } }
          : {}),
      },
    });
  return events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}
const responseText = {
  type: "message",
  id: "msg_final",
  role: "assistant",
  status: "completed",
  content: [
    { type: "output_text", text: "查证结果是 42 [W1]。", annotations: [] },
  ],
};
function responsesInput(base: string) {
  return {
    version: 1,
    runId: "responses-run",
    prompt: "搜索并读取来源",
    system: "核对来源",
    key: "fixture-secret",
    effort: "off",
    endpoint: base + "/responses",
    payload: { max_output_tokens: 8192, reasoning: { effort: "low" } },
    model: {
      id: "test",
      name: "test",
      provider: "custom",
      api: "openai-responses",
      baseUrl: base,
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32000,
      maxTokens: 4096,
    },
    tools: ["web_search", "web_fetch"].map((name) => ({
      name,
      description: name,
      schema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    })),
  };
}
async function responseWorker(
  input: ReturnType<typeof responsesInput>,
  cancelOn?: "draft" | "tool",
) {
  const child = spawn(process.execPath, ["dist/main.mjs"], { cwd: root });
  const events: any[] = [];
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  createInterface({ input: child.stdout }).on("line", (line) => {
    const event = JSON.parse(line);
    events.push(event);
    if (
      (cancelOn === "draft" && event.type === "draft" && event.text) ||
      (cancelOn === "tool" && event.type === "tool")
    ) {
      child.stdin.write(
        JSON.stringify({ type: "cancel", runId: input.runId }) + "\n",
      );
    } else if (event.type === "tool") {
      child.stdin.write(
        JSON.stringify({
          type: "toolResult",
          runId: input.runId,
          id: event.id,
          content: [
            {
              type: "text",
              text:
                event.name === "web_search"
                  ? "[W1] https://example.test/source"
                  : "[W1] 原文是 42",
            },
          ],
        }) + "\n",
      );
    }
  });
  child.stdin.write(JSON.stringify({ type: "start", input }) + "\n");
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  try {
    const code = await new Promise((resolve) => child.on("exit", resolve));
    return { code, events, stderr };
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}

test("Responses carries search and fetch results through Pi with stable tool IDs and history", async () => {
  const requests: any[] = [];
  const upstream = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push({
      body: JSON.parse(raw),
      url: req.url,
      authorization: req.headers.authorization,
    });
    const round = requests.length;
    const output =
      round === 1 || round === 2
        ? {
            type: "function_call",
            id: `fc_${round}`,
            call_id: `call_${round}`,
            name: round === 1 ? "web_search" : "web_fetch",
            arguments: JSON.stringify({
              query: round === 1 ? "answer" : "https://example.test/source",
            }),
            status: "completed",
          }
        : responseText;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(responseEvents(output));
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const input = responsesInput(
    `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1/nested`,
  );
  try {
    const result = await responseWorker(input);
    expect({
      code: result.code,
      stderr: result.stderr,
      errors: result.events.filter((e) => e.type === "error"),
    }).toEqual({ code: 0, stderr: "", errors: [] });
    expect(
      result.events
        .filter((e) => e.type === "tool")
        .map((e) => ({ id: e.id, runId: e.runId, name: e.name })),
    ).toEqual([
      { id: "call_1|fc_1", runId: "responses-run", name: "web_search" },
      { id: "call_2|fc_2", runId: "responses-run", name: "web_fetch" },
    ]);
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request.url).toBe("/v1/nested/responses");
      expect(request.authorization).toBe("Bearer fixture-secret");
      expect(request.body.max_output_tokens).toBe(8192);
      expect(request.body.reasoning).toEqual({ effort: "low" });
      expect(request.body.tools.map((tool: any) => tool.name)).toEqual([
        "web_search",
        "web_fetch",
      ]);
    }
    expect(
      requests[1].body.input.find(
        (item: any) => item.type === "function_call_output",
      ),
    ).toMatchObject({
      call_id: "call_1",
      output: "[W1] https://example.test/source",
    });
    expect(
      requests[2].body.input.filter(
        (item: any) => item.type === "function_call_output",
      ),
    ).toEqual([
      expect.objectContaining({
        call_id: "call_1",
        output: "[W1] https://example.test/source",
      }),
      expect.objectContaining({ call_id: "call_2", output: "[W1] 原文是 42" }),
    ]);
    const complete = result.events.at(-1);
    expect(complete).toMatchObject({
      type: "complete",
      text: "查证结果是 42 [W1]。",
    });
    const resumed = await responseWorker({
      ...input,
      entries: complete.entries,
    } as ReturnType<typeof responsesInput>);
    expect(resumed.code).toBe(0);
    expect(
      resumed.events.filter((event) => event.type === "tool"),
    ).toHaveLength(0);
    expect(
      requests[3].body.input.filter(
        (item: any) => item.type === "function_call_output",
      ),
    ).toHaveLength(2);
  } finally {
    upstream.close();
    upstream.closeAllConnections();
  }
}, 20000);

test.each([
  "truncated",
  "failed",
  "incomplete",
  "missing-status",
  "in_progress",
  "malformed",
  "cancel",
  "tool-cancel",
  "retryable",
])(
  "Responses refuses unrecovered %s without transport retries",
  async (mode) => {
    let requests = 0;
    const upstream = createServer(async (req, res) => {
      for await (const _chunk of req) {
        /* consume the request */
      }
      requests++;
      if (mode === "retryable") {
        res.writeHead(503);
        res.end('{"error":{"message":"unavailable"}}');
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (mode === "malformed") {
        res.end("event: response.completed\ndata: {not-json}\n\n");
        return;
      }
      if (mode === "tool-cancel") {
        res.end(
          responseEvents({
            type: "function_call",
            id: "fc_wait",
            call_id: "call_wait",
            name: "web_search",
            arguments: '{"query":"answer"}',
            status: "completed",
          }),
        );
        return;
      }
      res.write(
        responseEvents(responseText, mode === "cancel" ? "truncated" : mode),
      );
      if (mode !== "cancel") res.end();
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    try {
      const input = responsesInput(
        `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`,
      );
      const result = await responseWorker(
        input,
        mode === "cancel"
          ? "draft"
          : mode === "tool-cancel"
            ? "tool"
            : undefined,
      );
      expect(result.code).toBe(1);
      expect(result.events.some((event) => event.type === "error")).toBe(true);
      expect(result.events.some((event) => event.type === "complete")).toBe(
        false,
      );
      expect(requests).toBe(1);
      if (mode === "truncated" || mode === "failed" || mode === "cancel")
        expect(
          result.events.some(
            (event) => event.type === "draft" && event.text.includes("42"),
          ),
        ).toBe(true);
    } finally {
      upstream.close();
      upstream.closeAllConnections();
    }
  },
  15000,
);

test("Responses reports usage for both rounds when the refill fails without saving continuation", async () => {
  let requests = 0;
  const upstream = createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* consume */
    }
    requests++;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      requests === 1
        ? responseEvents({
            type: "function_call",
            id: "fc_search",
            call_id: "call_search",
            name: "web_search",
            arguments: '{"query":"answer"}',
            status: "completed",
          })
        : responseEvents(responseText, "incomplete"),
    );
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  try {
    const result = await responseWorker(
      responsesInput(
        `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`,
      ),
    );
    expect(result.code).toBe(1);
    expect(requests).toBe(2);
    expect(
      result.events
        .filter((event) => event.type === "usage")
        .map((event) => ({
          status: event.status,
          input: event.usage.input,
          output: event.usage.output,
        })),
    ).toEqual([
      { status: "complete", input: 10, output: 5 },
      { status: "failed", input: 10, output: 5 },
    ]);
    expect(result.events.some((event) => event.type === "complete")).toBe(
      false,
    );
  } finally {
    upstream.close();
    upstream.closeAllConnections();
  }
});

test.each(["redirect", "foreign-endpoint"])(
  "Responses keeps credentials at the configured origin for %s",
  async (mode) => {
    let foreignRequests = 0,
      upstreamRequests = 0;
    const foreign = createServer((_req, res) => {
      foreignRequests++;
      res.end();
    });
    await new Promise<void>((resolve) =>
      foreign.listen(0, "127.0.0.1", resolve),
    );
    const foreignURL = `http://127.0.0.1:${(foreign.address() as { port: number }).port}/responses`;
    const upstream = createServer(async (req, res) => {
      for await (const _chunk of req) {
        /* consume */
      }
      upstreamRequests++;
      res.writeHead(307, { location: foreignURL });
      res.end();
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    try {
      const input = responsesInput(
        `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`,
      );
      if (mode === "foreign-endpoint") input.endpoint = foreignURL;
      const result = await responseWorker(input);
      expect(result.code).toBe(1);
      expect(result.events.some((event) => event.type === "complete")).toBe(
        false,
      );
      expect(foreignRequests).toBe(0);
      expect(upstreamRequests).toBe(mode === "redirect" ? 1 : 0);
      expect(JSON.stringify(result.events)).not.toContain("fixture-secret");
    } finally {
      upstream.close();
      upstream.closeAllConnections();
      foreign.close();
      foreign.closeAllConnections();
    }
  },
);

test("Responses preserves SDK context-overflow compaction and recovery", async () => {
  let requests = 0;
  const upstream = createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* consume */
    }
    requests++;
    if (requests === 1) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        responseEvents({
          ...responseText,
          content: [
            {
              type: "output_text",
              text: "context ".repeat(10000),
              annotations: [],
            },
          ],
        }),
      );
    } else if (requests === 2) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            code: "context_length_exceeded",
            message: "This model's maximum context length has been exceeded",
          },
        }),
      );
    } else {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(responseEvents(responseText));
    }
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  try {
    const input = responsesInput(
      `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`,
    );
    input.model.contextWindow = 1000000;
    const first = await responseWorker(input);
    expect(first.code).toBe(0);
    const result = await responseWorker({
      ...input,
      entries: first.events.at(-1).entries,
    } as ReturnType<typeof responsesInput>);
    expect(result.code).toBe(0);
    expect(requests).toBe(4);
    expect(result.events.at(-1)).toMatchObject({
      type: "complete",
      text: "查证结果是 42 [W1]。",
    });
    expect(
      result.events
        .at(-1)
        .entries.some((entry: any) => entry.type === "compaction"),
    ).toBe(true);
    expect(
      result.events.some(
        (event) => event.type === "usage" && event.status === "failed",
      ),
    ).toBe(true);
  } finally {
    upstream.close();
    upstream.closeAllConnections();
  }
}, 15000);

test.each(["openai-responses", "openai-completions", "anthropic-messages"])(
  "%s preserves SDK recovery after a length-limited turn",
  async (api) => {
    let requests = 0;
    const upstream = createServer(async (req, res) => {
      for await (const _chunk of req) {
        /* consume */
      }
      requests++;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (api === "openai-responses") {
        res.end(
          responseEvents(
            requests === 1
              ? {
                  type: "function_call",
                  id: "fc_partial",
                  call_id: "call_partial",
                  name: "web_search",
                  arguments: '{"query":"answer"}',
                  status: "completed",
                }
              : responseText,
            requests === 1 ? "incomplete" : "completed",
          ),
        );
      } else if (api === "openai-completions") {
        res.write(
          `data: ${JSON.stringify({ id: "chat_fixture", choices: [{ index: 0, delta: requests === 1 ? { tool_calls: [{ index: 0, id: "call_partial", type: "function", function: { name: "web_search", arguments: '{"query":"answer"}' } }] } : { content: "recovered answer" }, finish_reason: null }] })}\n\n`,
        );
        res.end(
          `data: ${JSON.stringify({ id: "chat_fixture", choices: [{ index: 0, delta: {}, finish_reason: requests === 1 ? "length" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`,
        );
      } else {
        for (const event of [
          {
            type: "message_start",
            message: {
              id: "msg_fixture",
              type: "message",
              role: "assistant",
              model: "test",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 10, output_tokens: 0 },
            },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block:
              requests === 1
                ? {
                    type: "tool_use",
                    id: "call_partial",
                    name: "web_search",
                    input: {},
                  }
                : { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta:
              requests === 1
                ? {
                    type: "input_json_delta",
                    partial_json: '{"query":"answer"}',
                  }
                : { type: "text_delta", text: "recovered answer" },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: {
              stop_reason: requests === 1 ? "max_tokens" : "end_turn",
              stop_sequence: null,
            },
            usage: { output_tokens: 5 },
          },
          { type: "message_stop" },
        ])
          res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        res.end();
      }
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    try {
      const input = responsesInput(
        `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`,
      );
      input.model.api = api;
      const result = await responseWorker(input);
      expect(result.code).toBe(0);
      expect(requests).toBe(2);
      expect(
        result.events.filter((event) => event.type === "tool"),
      ).toHaveLength(0);
      expect(result.events.filter((event) => event.type === "usage")).toEqual([
        expect.objectContaining({ status: "failed" }),
        expect.objectContaining({ status: "complete" }),
      ]);
      expect(result.events.some((event) => event.type === "complete")).toBe(
        true,
      );
    } finally {
      upstream.close();
      upstream.closeAllConnections();
    }
  },
  15000,
);

test.each([
  { totalTokens: 25599, compact: false },
  { totalTokens: 25600, compact: false },
  { totalTokens: 25601, compact: true },
])(
  "80% context threshold at $totalTokens tokens compacts=$compact",
  async ({ totalTokens, compact }) => {
    let requests = 0;
    const upstream = createServer(async (req, res) => {
      for await (const _chunk of req) {
        /* consume */
      }
      requests++;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const output =
        requests === 1
          ? {
              ...responseText,
              content: [
                {
                  type: "output_text",
                  text: "context ".repeat(10000),
                  annotations: [],
                },
              ],
            }
          : responseText;
      res.end(
        responseEvents(output, "completed", requests === 2 ? totalTokens : 15),
      );
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    try {
      const input = responsesInput(
        `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`,
      );
      const first = await responseWorker(input);
      expect(first.code).toBe(0);
      const second = await responseWorker({
        ...input,
        entries: first.events.at(-1).entries,
      } as ReturnType<typeof responsesInput>);
      expect(second.code).toBe(0);
      expect(requests).toBe(compact ? 3 : 2);
      expect(second.events.some((event) => event.type === "activity")).toBe(
        compact,
      );
      expect(
        second.events
          .at(-1)
          .entries.some((entry: any) => entry.type === "compaction"),
      ).toBe(compact);
    } finally {
      upstream.close();
      upstream.closeAllConnections();
    }
  },
  15000,
);
