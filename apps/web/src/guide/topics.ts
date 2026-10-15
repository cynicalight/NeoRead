// Guide content shared by the first-run onboarding and the in-app guide.
// Add a topic here to show it in the guide; mark it `onboarding` to also
// include it in the first-run walkthrough, in this order.
import {
  BookOpenText,
  Bot,
  FileUp,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";
import type { SceneId } from "./scenes";

export interface GuideStep {
  id: string;
  title: string;
  body: string;
  scene: SceneId;
}

/** What the topic's button opens in the app. */
export type GuideAction = "settings" | "import";

export interface GuideTopic {
  id: string;
  title: string;
  icon: LucideIcon;
  steps: GuideStep[];
  onboarding?: boolean;
  action?: { kind: GuideAction; label: string };
}

export const guideTopics: GuideTopic[] = [
  {
    id: "agent",
    title: "设置 Agent",
    icon: Bot,
    onboarding: true,
    action: { kind: "settings", label: "打开设置" },
    steps: [
      {
        id: "detect",
        title: "自动检测本机 Agent",
        body: "打开「设置 → Agent」，Reader 会自动检测已安装的 Codex、Claude Code 和 Kimi CLI，并测试文本推理与图片理解。检测通过后，在「Agent SDK」中选择要使用的一个。",
        scene: "detect",
      },
      {
        id: "login",
        title: "在终端登录 CLI",
        body: "Reader 直接调用 CLI，使用它当前的登录账户与计费方式，不读取账号凭据。检测未通过时，先在终端完成登录：Codex 运行 codex login，Claude Code 运行 claude auth login，Kimi 启动后按提示登录。登录后回到设置点击重新检测。",
        scene: "login",
      },
      {
        id: "api",
        title: "或者填入 API Key",
        body: "没有安装 CLI 时，点击 API 卡片，填写 OpenAI 兼容接口的地址和 Key 并保存。Reader 会拉取模型列表并逐个检测，Key 只保存在本机。",
        scene: "api",
      },
    ],
  },
  {
    id: "models",
    title: "为任务选择模型",
    icon: SlidersHorizontal,
    onboarding: true,
    action: { kind: "settings", label: "打开设置" },
    steps: [
      {
        id: "task-models",
        title: "问答和翻译分开选模型",
        body: "问答需要理解和推理，选能力强的模型。翻译调用量大，选最低档的快速模型即可，例如 Codex 的 Luna、Kimi 或 API 中的 Flash；Effort 也可以调到 Low。",
        scene: "models",
      },
    ],
  },
  {
    id: "import",
    title: "导入论文",
    icon: FileUp,
    onboarding: true,
    action: { kind: "import", label: "导入论文" },
    steps: [
      {
        id: "link",
        title: "从链接导入",
        body: "在论文库点击「导入论文」，粘贴论文页面或 PDF 链接，也可以输入 arXiv 编号、DOI 或完整标题。Reader 会下载 PDF 并补全论文信息。",
        scene: "link",
      },
      {
        id: "pdf",
        title: "导入本地 PDF",
        body: "把 PDF 拖进窗口即可导入，也可以在「导入论文」中点「选择 PDF 文件」。论文导入后默认自动翻译全文，可在「设置 → 论文库」中关闭。",
        scene: "pdf",
      },
    ],
  },
  {
    id: "reading",
    title: "阅读界面",
    icon: BookOpenText,
    onboarding: true,
    steps: [
      {
        id: "modes",
        title: "三种阅读模式",
        body: "在阅读工具栏右侧切换「仅原文」「原文译文」「仅译文」。对照模式下原文和译文并排显示，悬停句子时两侧对应高亮。",
        scene: "modes",
      },
      {
        id: "assistant",
        title: "侧栏 Agent",
        body: "选中文字后，在浮动工具栏点「问 AI」，回答会出现在右侧 Agent 栏。也可以把多段文字引用到对话，或直接在底部输入框提问。",
        scene: "assistant",
      },
    ],
  },
];

export interface GuidePage {
  topic: GuideTopic;
  step: GuideStep;
  /** Position within the topic. */
  index: number;
}

export const guidePages = (topics: GuideTopic[]) =>
  topics.flatMap((topic) =>
    topic.steps.map((step, index): GuidePage => ({ topic, step, index })),
  );

export const onboardingPages = () =>
  guidePages(guideTopics.filter((topic) => topic.onboarding));
