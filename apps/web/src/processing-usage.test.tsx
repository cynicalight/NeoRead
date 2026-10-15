// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { ProcessingUsage } from "@reader/core";
import { UsageDetails, combineUsageReports } from "./ProcessingUsage";
const total = {
  inputTokens: 10,
  outputTokens: 5,
  totalTokens: 15,
  cachedInputTokens: 7,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 2,
};
const report: ProcessingUsage = {
  historyComplete: true,
  total,
  calls: [
    {
      id: "one",
      stage: "settling",
      target: "p1-b1",
      provider: "codex",
      startedAt: "2026-10-06T00:00:00Z",
      finishedAt: "2026-10-06T00:00:10Z",
      status: "failed",
      models: [{ model: "actual", tokens: total }],
    },
  ],
  groups: [
    {
      stage: "settling",
      provider: "codex",
      model: "actual",
      calls: 1,
      unknownCalls: 0,
      tokens: total,
    },
  ],
  stages: [
    { stage: "learning", durationMs: 1000 },
    { stage: "settling", durationMs: 10000 },
    { stage: "translating", durationMs: 0 },
  ],
  unknownCalls: 0,
  failedCalls: 1,
  partialCalls: 1,
  elapsedMs: 11000,
};
it("shows actual model usage without adding cache subsets again", () => {
  const text = renderToStaticMarkup(<UsageDetails report={report} />);
  expect(text).toContain("15 tokens");
  expect(text).toContain("actual");
});
it("never represents missing or historical usage as zero tokens", () => {
  const unknown: ProcessingUsage = {
    ...report,
    historyComplete: false,
    total: { ...total, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    calls: [{ ...report.calls[0], models: [{ model: "", tokens: null }] }],
    groups: [{ ...report.groups[0], model: "", unknownCalls: 1 }],
    unknownCalls: 1,
    partialCalls: 0,
  };
  const text = renderToStaticMarkup(<UsageDetails report={unknown} />);
  expect(text).toContain("历史用量未记录");
  expect(text).toContain("用量未知");
  expect(text).toContain("模型未返回");
  expect(text).not.toContain("0 tokens");
});

it("combines processing and chat totals without counting cache subsets twice", () => {
  const chatReport = {
    ...report,
    total,
    calls: [
      { ...report.calls[0], stage: "chat", target: "question" },
      { ...report.calls[0], id: "retry", stage: "chat", target: "question" },
    ],
    groups: report.groups.map((group) => ({ ...group, stage: "chat" })),
    stages: [{ stage: "chat", durationMs: 10000 }],
    elapsedMs: 10000,
  };
  const combined = combineUsageReports(report, chatReport);
  expect(combined.total.totalTokens).toBe(30);
  expect(combined.total.cachedInputTokens).toBe(14);
  expect(combined.elapsedMs).toBe(21000);
});

it("keeps same-model provider successes and failures separate", () => {
  const twoProviders = {
    ...report,
    calls: [
      {
        ...report.calls[0],
        provider: "api",
        providerId: "one",
        providerName: "First",
        status: "complete",
      },
      {
        ...report.calls[0],
        id: "two",
        provider: "api",
        providerId: "two",
        providerName: "Second",
        status: "failed",
      },
    ],
    groups: [
      {
        ...report.groups[0],
        provider: "api",
        providerId: "one",
        providerName: "First",
      },
      {
        ...report.groups[0],
        provider: "api",
        providerId: "two",
        providerName: "Second",
      },
    ],
  };
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<UsageDetails report={twoProviders} />);
  const rows = host.querySelectorAll(".usage-model");
  expect(rows).toHaveLength(2);
  expect(rows[0].textContent).toContain("First");
  expect(rows[1].textContent).toContain("Second");
  expect(rows[0].textContent).toContain("未成功0");
  expect(rows[1].textContent).toContain("成功0");
});

function renderUsage(value: ProcessingUsage) {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<UsageDetails report={value} />);
  return host;
}
function pricedReport(amount: number | null = 0.0026): ProcessingUsage {
  return {
    ...report,
    calls: [
      {
        ...report.calls[0]!,
        provider: "api",
        price: {
          currency: "CNY",
          input: 2,
          model: "actual",
          sources: { input: "model" },
        },
        models: [
          {
            model: "actual",
            tokens: total,
            cost: {
              currency: "CNY",
              amount,
              status: amount === null ? "unknown" : "partial",
            },
          },
        ],
      },
    ],
    groups: [{ ...report.groups[0]!, provider: "api" }],
  };
}
it.each(["codex", "claude", "kimi"])(
  "hides fee UI for %s calls even if old aggregates contain costs",
  (provider) => {
    const value = pricedReport();
    value.calls[0]!.provider = provider;
    value.groups[0]!.provider = provider;
    value.cost = {
      currencies: [{ currency: "USD", amount: 99 }],
      unknownCalls: 1,
      partialCalls: 0,
    };
    value.groups[0]!.cost = value.cost;
    const host = renderUsage(value);
    expect(host.textContent).toContain("15 tokens");
    expect(host.textContent).not.toMatch(/估算费用|费用未知|价格来源|USD|CNY/);
  },
);
it.each(["no price", "no rates", "no amount", "no usage"])(
  "hides API fee UI with %s",
  (missing) => {
    const value = pricedReport(missing === "no amount" ? null : 0.0026);
    if (missing === "no price") delete value.calls[0]!.price;
    if (missing === "no rates") delete value.calls[0]!.price!.input;
    if (missing === "no usage") value.calls[0]!.models[0]!.tokens = null;
    const host = renderUsage(value);
    expect(host.textContent).not.toMatch(/估算费用|费用未知|价格来源|CNY/);
  },
);
it("shows the stored API amount and source even when report aggregates are absent", () => {
  const value = pricedReport();
  const host = renderUsage(value);
  expect(host.textContent).toContain("CNY 0.0026");
  expect(host.textContent).toContain("部分估算 1 次");
  expect(host.querySelector(".usage-model")?.textContent).toContain(
    "价格来源 模型价格",
  );
  expect(host.textContent).not.toContain("费用未知");
  expect(value.calls[0]!.models[0]!.cost!.amount).toBe(0.0026);
});
it("shows explicitly priced zero API usage as zero", () => {
  const value = pricedReport(0);
  value.calls[0]!.price!.input = 0;
  const host = renderUsage(value);
  expect(host.textContent).toContain("CNY 0");
  expect(host.textContent).toContain("价格来源");
});
it("sums only priced API snapshots across mixed histories and separates currencies", () => {
  const processing = pricedReport();
  const second = pricedReport(0.001);
  const usd = pricedReport(0.01);
  usd.calls[0]!.price!.currency = "USD";
  usd.calls[0]!.models[0]!.cost!.currency = "USD";
  const cli = pricedReport(50);
  cli.calls[0]!.provider = "codex";
  cli.groups[0]!.provider = "codex";
  const unknown = pricedReport();
  delete unknown.calls[0]!.price;
  const chat = [second, usd, cli, unknown].reduce(combineUsageReports);
  const combined = combineUsageReports(processing, chat);
  const snapshots = JSON.stringify(combined.calls);
  const host = renderUsage(combined);
  const summary = host.querySelector(".usage-totals")!.nextElementSibling!;
  expect(summary.textContent).toContain("CNY 0.0036");
  expect(summary.textContent).toContain("USD 0.01");
  expect(summary.textContent).not.toContain("费用未知");
  expect(
    host.querySelector('[aria-label="actual 调用统计"]')?.textContent,
  ).toContain("CNY 0.0036");
  const cliGroup = Array.from(host.querySelectorAll(".usage-model")).find(
    (group) => group.textContent?.includes("Codex"),
  );
  expect(cliGroup?.textContent).not.toMatch(/估算费用|价格来源/);
  expect(host.textContent).toContain("75 tokens");
  expect(JSON.stringify(combined.calls)).toBe(snapshots);
});

it("marks a mixed-price API call partial without marking its fully priced model partial", () => {
  const value = pricedReport();
  value.calls[0]!.status = "complete";
  value.calls[0]!.models[0]!.cost!.status = "complete";
  value.calls[0]!.models.push({
    model: "unpriced",
    tokens: total,
    cost: { amount: null, status: "unknown" },
  });
  value.groups.push({ ...value.groups[0]!, model: "unpriced" });
  const host = renderUsage(value);
  const summary = host.querySelector(".usage-totals")!.nextElementSibling!;
  expect(summary.textContent).toContain("CNY 0.0026");
  expect(summary.textContent).toContain("部分估算 1 次");
  const priced = host.querySelector('[aria-label="actual 调用统计"]')!;
  expect(priced.textContent).toContain("CNY 0.0026");
  expect(priced.textContent).not.toContain("部分估算");
  const unpriced = host.querySelector('[aria-label="unpriced 调用统计"]')!;
  expect(unpriced.textContent).not.toMatch(/估算费用|费用未知|价格来源/);
});
