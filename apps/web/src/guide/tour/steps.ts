// The first-run tour: each step reads a snapshot of the app and says what to
// highlight, which areas accept clicks and where the pointer goes. Steps
// advance by themselves when the app reaches the state they ask for.
import type { Side } from "./geometry";

export type AgentStatus = "ready" | "failed" | "pending" | "missing";

export interface TourState {
  settings: boolean;
  /** The Agent tab of the settings is showing. */
  agentPanel: boolean;
  detecting: boolean;
  apiDetails: boolean;
  deckOpen?: boolean;
  agentDetails?: boolean;
  agents: { id: string; status: AgentStatus }[];
  primary?: string;
  /** The selected agent passed the text check. */
  primaryReady: boolean;
  taskModels: boolean;
  /** The sidebar's settings button is on screen. */
  sidebar: boolean;
  importDialog: boolean;
  /** Documents added since the tour started. */
  imported: number;
  examplePaper?: boolean;
  libraryTarget?: string;
  /** The library lists a document to open: a paper row or a book card. */
  library?: "paper" | "book";
  reading: boolean;
  readingModes: boolean;
  pdfReading?: boolean;
  parallel?: boolean;
  sourceBlock?: boolean;
  blockFocused?: boolean;
  assistant: boolean;
  /** Where the user runs CLI commands: 终端, or PowerShell on Windows. */
  shell: string;
  /** How the user chose to connect an agent. */
  method?: string;
  /** Steps confirmed with their button. */
  acknowledged: ReadonlySet<string>;
}

export type Pointer =
  | {
      gesture: "click" | "double" | "hover";
      target: string;
      /** Point near the start of a wide target such as a form. */
      align?: "start";
    }
  | { gesture: "wander"; targets: string[] };

export interface TourView {
  title: string;
  body: string;
  /** Framed and lit, but not clickable. */
  focus?: string[];
  /** Framed, lit and clickable; the rest of the window ignores the pointer. */
  click?: string[];
  pointer?: Pointer;
  /** Only steps with an explicit label show a card button. */
  next?: string;
  /** Activate an existing control; wait for its state change before advancing. */
  nextTarget?: string;
  /** Advance after the user clicks this UI target. */
  advanceOn?: string;
  /** Allow time to observe a completed demonstration before continuing. */
  advanceAfter?: number;
  /** What the card sits beside, if not the first lit area. */
  anchor?: string;
  side?: Side;
  /** Centre a card in the expanded deck without selecting its provider. */
  revealAgent?: string;
  /** Choices shown on the card; picking one sets `TourState.method`. */
  options?: { value: string; label: string; disabled?: boolean }[];
  /** A web page linked where the body says `{link}`. */
  link?: { label: string; url: string };
  chosen?: string;
}

export interface TourStep {
  id: string;
  skip?: (s: TourState) => boolean;
  done?: (s: TourState) => boolean;
  /** Return to an earlier step after the app left the state this one needs. */
  back?: (s: TourState) => string | undefined;
  view: (s: TourState) => TourView;
}

export const agentNames: Record<string, string> = {
  codex: "Codex",
  claude: "Claude Code",
  kimi: "Kimi",
  api: "API",
};

const tour = (name: string) => `[data-tour="${name}"]`;
/** The first document in the library: a paper row or a book card. */
export const libraryItem = ":is([data-paper-id], .book-card)";
/** The reading mode tabs a reading view puts in the toolbar. */
export const readingModes =
  '[data-tour="reading-modes"] [data-slot="tabs-list"]';
const assistantToggle = '[aria-label="Agent 与批注"]';
const closeImport = `${tour("import-dialog")} > [data-slot="dialog-close"]`;
const deck = `${tour("agent-deck")}[data-spread]`;
const card = (id: string) =>
  `${deck} ${tour("agent-card")}[data-agent="${id}"]`;
const closeDeck = (): TourView => ({
  title: "收起 Agent 卡片",
  body: "单击空白处收起 Agent 卡片，接下来了解导入和阅读。",
  focus: [],
  click: [tour("agent-deck-backdrop")],
  pointer: { gesture: "click", target: tour("agent-deck-dismiss") },
  next: "收起并继续",
  nextTarget: tour("agent-deck-dismiss"),
});
const apiKey = `${tour("api-form")} input[aria-label="API Key"]`;
const deepseek = "https://platform.deepseek.com/api_keys";
const localAgents = ["codex", "claude", "kimi"];
const connections = [
  { value: "local", label: "本地 CLI Agent" },
  { value: "api", label: "API Key" },
];

export const join = (names: string[]) =>
  names.length < 2
    ? names.join("")
    : `${names.slice(0, -1).join("、")}和${names.at(-1)}`;

function agentView(s: TourState): TourView {
  if (s.agentDetails)
    return {
      title: "返回 Agent 卡片",
      body: "可以在这里查看本地调用记录。返回卡片后继续引导。",
      focus: [tour("agent-detail")],
      click: [tour("agent-detail")],
      pointer: {
        gesture: "click",
        target: `${tour("agent-detail")} [aria-label="返回卡片"]`,
      },
      next: "返回卡片",
      nextTarget: `${tour("agent-detail")} [aria-label="返回卡片"]`,
    };
  // The API settings replace the tabs, so check them first.
  if (s.apiDetails)
    return s.agents.some((a) => a.id === "api" && a.status === "ready")
      ? {
          title: "API 已可用",
          body: "已有模型通过检测。点左上角返回，选择要使用的 Agent。",
          click: [tour("api-panel")],
          pointer: { gesture: "click", target: tour("api-back") },
        }
      : {
          title: "填写 API Key",
          body: "还没有 API Key 的话，推荐到 DeepSeek 开放平台（{link}）注册。API 地址已经默认填 https://api.deepseek.com，把 Key 粘贴到这里并保存即可。\n当然，也支持其他 API Key，需要改对应平台的 Base URL。",
          focus: [apiKey],
          click: [tour("api-panel")],
          pointer: { gesture: "click", target: apiKey },
          anchor: tour("api-form"),
          side: "right",
          link: { label: "platform.deepseek.com", url: deepseek },
        };
  if (!s.agentPanel)
    return {
      title: "回到 Agent 设置",
      body: "点击左侧的「Agent」。",
      click: [tour("settings-agent-tab")],
      pointer: { gesture: "click", target: tour("settings-agent-tab") },
    };
  const choice = { options: connections, chosen: s.method };
  if (!s.method)
    return {
      title: "选择连接方式",
      body: "问答和翻译由 AI 完成。可以使用本机已登录的 Codex、Claude Code 或 Kimi CLI，也可以填写 OpenAI 兼容接口的 API Key。",
      focus: [tour("agent-connection")],
      pointer: { gesture: "hover", target: ".tour-options" },
      ...choice,
    };
  if (!s.deckOpen)
    return {
      title: "展开 Agent 卡片",
      body: "点击卡片组展开，再选择要连接的服务。",
      focus: [tour("agent-connection")],
      click: [tour("agent-stack")],
      pointer: { gesture: "click", target: tour("agent-stack") },
      ...choice,
    };
  if (
    s.primaryReady &&
    (s.method === "api"
      ? s.primary === "api"
      : localAgents.includes(s.primary ?? ""))
  )
    return closeDeck();
  const api = s.method === "api";
  const mine = s.agents.filter((a) =>
    api ? a.id === "api" : localAgents.includes(a.id),
  );
  const ready = mine.filter((a) => a.status === "ready").map((a) => a.id);
  if (ready.length) {
    const first = ready.includes(s.primary ?? "") ? s.primary! : ready[0];
    const names = join(ready.map((id) => agentNames[id]));
    return {
      title: `选择 ${agentNames[first]}`,
      body: api
        ? "API 已有模型通过检测，点击 API 卡片选择它，问答和翻译会使用这个 Key。"
        : `${names} 的 CLI 已在${s.shell}中登录，NeoRead 用的是 CLI，不是 Codex App。点击卡片选择要使用的 Agent，问答和翻译会使用它当前的登录账户与计费方式。`,
      focus: [card(first)],
      click: [deck],
      revealAgent: first,
      pointer: { gesture: "click", target: card(first) },
      ...choice,
    };
  }
  if (api)
    return mine.some((a) => a.status === "pending")
      ? {
          title: "正在检测 API 模型",
          body: "NeoRead 正在拉取模型并逐个测试文本推理和图片理解。",
          focus: [card("api")],
          click: [deck],
          revealAgent: "api",
          pointer: { gesture: "hover", target: card("api") },
          ...choice,
        }
      : {
          title: "配置 API Key",
          body: "展开 Agent 卡片，点击 API 卡片进入 API 配置。Key 只保存在本机。",
          focus: [card("api")],
          click: [deck],
          revealAgent: "api",
          pointer: { gesture: "click", target: card("api") },
          ...choice,
        };
  if (s.detecting || mine.some((a) => a.status === "pending"))
    return {
      title: "正在检测本机 Agent",
      body: `NeoRead 调用的是命令行里的 Codex、Claude Code 和 Kimi CLI，不是 Codex App 或 Claude 桌面版。请在${s.shell}中确认 CLI 已登录，例如运行 \`codex login\` 或 \`claude auth login\`。`,
      focus: [deck],
      click: [deck],
      ...choice,
    };
  const failed = mine.filter((a) => a.status === "failed");
  return failed.length
    ? {
        title: "Agent 还不能使用",
        body: "没有可用的 agent，通常是 CLI 还没有登录。[[请在 mac 终端 / windows powershell 中运行 `codex login` / `claude auth login` / `kimi`]]，然后点右上角重新检测，或者改用 API Key。",
        focus: [deck],
        click: [deck, '[data-slot="agent-deck"] [aria-label="刷新全部状态"]'],
        pointer: {
          gesture: "click",
          target: '[data-slot="agent-deck"] [aria-label="刷新全部状态"]',
        },
        ...choice,
      }
    : {
        title: "没有找到本机 Agent",
        body: `未检测到 Codex、Claude Code 或 Kimi CLI。只装了 Codex App 或 Claude 桌面版不行，需要在${s.shell}中安装 CLI 并登录，然后点右上角重新检测，或者改用 API Key。`,
        focus: [deck],
        click: [deck, '[data-slot="agent-deck"] [aria-label="刷新全部状态"]'],
        pointer: {
          gesture: "click",
          target: '[data-slot="agent-deck"] [aria-label="刷新全部状态"]',
        },
        ...choice,
      };
}

export const tourSteps: TourStep[] = [
  {
    id: "welcome",
    view: () => ({
      title: "欢迎使用 NeoRead",
      body: "跟着光标完成三件事：连接 Agent、导入论文、开始阅读。大约一分钟。",
      next: "开始",
    }),
  },
  {
    id: "settings",
    done: (s) => s.settings,
    view: (s) =>
      s.sidebar
        ? {
            title: "先连接 AI Agent",
            body: "问答和翻译都由 Agent 完成。点击「设置」。",
            click: [tour("open-settings")],
            pointer: { gesture: "click", target: tour("open-settings") },
          }
        : {
            title: "打开侧栏",
            body: "设置在侧栏底部，先展开侧栏。",
            click: ['[aria-label="切换侧栏"]'],
            pointer: { gesture: "click", target: '[aria-label="切换侧栏"]' },
          },
  },
  {
    id: "agent",
    // Closing the settings once an agent works moves the tour on as well.
    done: (s) =>
      !s.deckOpen &&
      s.primaryReady &&
      (!s.method ||
        (s.method === "local"
          ? localAgents.includes(s.primary ?? "")
          : s.method === s.primary)) &&
      (!s.settings || (s.agentPanel && !s.detecting && !s.apiDetails)),
    skip: (s) => !s.settings && s.acknowledged.has("settings"),
    back: (s) => (s.settings || s.primaryReady ? undefined : "settings"),
    view: (s) => ({ next: "下一步", ...agentView(s) }),
  },
  {
    id: "models",
    skip: (s) =>
      !s.settings || !s.taskModels || s.apiDetails || !s.primaryReady,
    done: (s) => !s.settings,
    view: (s) =>
      s.deckOpen
        ? closeDeck()
        : {
            title: "为任务选择模型",
            body: "问答需要推理，选能力强的模型；翻译调用量大，选快速模型即可，Effort 也可以调低。保持默认也能使用。设置好后，点击右上角关闭。",
            click: [
              tour("task-models"),
              `${tour("settings")} > [data-slot="dialog-close"]`,
            ],
            pointer: {
              gesture: "click",
              target: `${tour("settings")} > [data-slot="dialog-close"]`,
            },
          },
  },
  {
    id: "close-settings",
    done: (s) => !s.settings,
    view: (s) =>
      s.deckOpen
        ? closeDeck()
        : {
            title: s.primaryReady ? "Agent 已就绪" : "稍后配置 Agent",
            body: "关闭设置，接下来了解导入入口并体验示例论文。",
            next: "关闭设置并继续",
            nextTarget: `${tour("settings")} > [data-slot="dialog-close"]`,
            click: [`${tour("settings")} > [data-slot="dialog-close"]`],
            pointer: {
              gesture: "click",
              target: `${tour("settings")} > [data-slot="dialog-close"]`,
            },
          },
  },
  {
    id: "import",
    skip: (s) => s.reading,
    done: (s) => s.importDialog || s.imported > 0,
    view: (s) =>
      s.sidebar
        ? {
            title: "导入论文",
            body: "点击「导入论文」。也可以随时把 PDF 拖进窗口。",
            click: [tour("import")],
            pointer: { gesture: "click", target: tour("import") },
          }
        : {
            title: "打开侧栏",
            body: "导入按钮在侧栏底部，先展开侧栏。",
            click: ['[aria-label="切换侧栏"]'],
            pointer: { gesture: "click", target: '[aria-label="切换侧栏"]' },
          },
  },
  {
    id: "import-dialog",
    done: (s) => !s.importDialog,
    view: () => ({
      title: "粘贴链接或选择 PDF",
      body: "NeoRead 支持导入本地 pdf、粘贴论文链接、arXiv 编号，也可以选择直接从 Zotero 中迁移完整的论文库。\n**可以在新手引导结束后，导入自己的论文，接下来直接用示例论文演示。**",
      focus: [tour("import-dialog")],
      click: [closeImport],
      pointer: { gesture: "click", target: closeImport },
    }),
  },
  {
    id: "open",
    skip: (s) => !s.reading && !s.library,
    done: (s) => s.reading,
    view: (s) => ({
      title: "打开论文",
      body:
        s.library === "book"
          ? "点击封面开始阅读。"
          : s.examplePaper
            ? "**双击示例论文 Attention Is All You Need** 开始阅读。这篇论文已完成解析和中文翻译，可以直接体验阅读功能。"
            : "**双击论文**开始阅读。论文解析完成后即可打开，翻译会在后台继续。",
      click: [s.libraryTarget ?? libraryItem],
      pointer: {
        gesture: s.library === "book" ? "click" : "double",
        target: s.libraryTarget ?? libraryItem,
      },
    }),
  },
  {
    id: "modes",
    done: (s) => !!s.pdfReading && !!s.parallel,
    skip: (s) => !s.readingModes,
    back: (s) => (!s.reading && s.library ? "open" : undefined),
    view: (s) =>
      s.pdfReading
        ? {
            title: "切换到原文译文",
            body: "点击「原文译文」，并排查看论文原文和中文翻译。",
            click: [readingModes],
            pointer: { gesture: "click", target: tour("parallel-mode") },
          }
        : {
            title: "切换阅读模式",
            body: "在「仅原文」「原文译文」「仅译文」之间切换。对照模式下悬停句子，两侧对应高亮。",
            click: [readingModes],
            pointer: { gesture: "hover", target: readingModes },
            advanceOn: readingModes,
          },
  },
  {
    id: "focus-block",
    skip: (s) => !s.pdfReading,
    back: (s) =>
      !s.reading && s.library ? "open" : !s.parallel ? "modes" : undefined,
    view: (s) =>
      s.blockFocused
        ? {
            title: "聚焦原文段落",
            body: "原文段落已聚焦，右侧译文也定位到对应段落。阅读时可以点击其他段落，继续对照查看。",
            focus: [
              tour("source-block"),
              "[data-translation-block][data-focused]",
            ],
            advanceAfter: 3000,
          }
        : s.sourceBlock
          ? {
              title: "聚焦原文段落",
              body: "点击鼠标指向的原文段落，聚焦这一段，并让右侧译文定位到对应内容。",
              click: [tour("source-block")],
              pointer: { gesture: "click", target: tour("source-block") },
            }
          : {
              title: "准备段落演示",
              body: "段落加载后，会在这里演示原文与译文的聚焦效果。",
            },
  },
  {
    id: "assistant",
    skip: (s) => !s.reading,
    back: (s) => (!s.reading && s.library ? "open" : undefined),
    view: (s) =>
      s.assistant
        ? {
            title: "向 AI 提问",
            body: "选中文字后，在浮动工具栏点「问 AI」，回答会出现在这里。也可以引用多段文字，或直接在输入框提问。点击输入框继续。",
            focus: [tour("assistant")],
            click: [tour("compose")],
            advanceOn: tour("compose"),
            pointer: { gesture: "click", target: tour("compose") },
            anchor: tour("assistant"),
            side: "left",
          }
        : {
            title: "打开 Agent 栏",
            body: "点击右上角的 Agent 按钮。",
            click: [assistantToggle],
            pointer: { gesture: "click", target: assistantToggle },
          },
  },
  {
    id: "finish",
    view: (s) => ({
      title: "准备就绪",
      body: "更多功能在侧栏的「指南」里，可以随时重新开始这段引导。",
      focus: s.sidebar && !s.reading ? [tour("guide")] : undefined,
      next: "完成",
    }),
  },
];

/**
 * The step to show: an earlier one if the app left the current step's state,
 * otherwise the first step from here that is neither skipped nor done.
 * Returns `steps.length` once every step is done.
 */
export function resolveStep(
  steps: TourStep[],
  index: number,
  state: TourState,
): number {
  let i = index;
  const back = steps[i]?.back?.(state);
  if (back)
    i = Math.max(
      0,
      steps.findIndex((s) => s.id === back),
    );
  while (i < steps.length) {
    const step = steps[i];
    if (
      state.acknowledged.has(step.id) ||
      step.skip?.(state) ||
      step.done?.(state)
    )
      i++;
    else break;
  }
  return i;
}
