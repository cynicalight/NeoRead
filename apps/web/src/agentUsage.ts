import { api } from "@neoread/api";
import type { Document } from "@neoread/core";
import { usageStageLabels } from "./ProcessingUsage";

export interface RecentCall {
  id: string;
  label: string;
  target: string;
  model: string;
  amount: string;
  at: string;
  failed: boolean;
}

// Local usage is stored per document, so only recently opened ones are read.
const recentDocuments = 8;
const limit = 20;
const count = (value: number) => value.toLocaleString("zh-CN");

const matches = (agent: string, provider: string) =>
  agent === "api"
    ? provider === "api" || provider === "text-api" || provider === "image-api"
    : provider === agent;

/** Recent calls for a deck card, read only from local document usage. */
export async function recentAgentCalls(
  agent: string,
  documents: Document[],
  signal?: AbortSignal,
): Promise<RecentCall[]> {
  const recent = documents
    .filter((doc) => !doc.deletedAt)
    .sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt))
    .slice(0, recentDocuments);
  const groups = await Promise.all(
    recent.flatMap((doc) =>
      [api.processingUsage(doc.id), api.chatUsage(doc.id)].map((request) =>
        request.then(
          (usage) => usage.calls.map((call) => ({ call, doc })),
          () => [],
        ),
      ),
    ),
  );
  return groups
    .flat()
    .filter(({ call }) => matches(agent, call.provider))
    .sort((a, b) => b.call.startedAt.localeCompare(a.call.startedAt))
    .slice(0, limit)
    .map(({ call, doc }) => {
      const tokens = call.models.reduce(
        (sum, model) => sum + (model.tokens?.totalTokens ?? 0),
        0,
      );
      return {
        id: `${doc.id}:${call.id}`,
        label: usageStageLabels[call.stage] ?? call.stage,
        target: doc.title,
        model: call.models.map((model) => model.model).join("、"),
        amount: tokens ? `${count(tokens)} tokens` : "",
        at: call.startedAt,
        failed: call.status === "failed",
      };
    });
}
