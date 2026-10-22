// Guide content shared by the first-run onboarding and the in-app guide.
// Add a topic here to show it in the guide; mark it `onboarding` to also
// include it in the first-run walkthrough, in this order.
import {
  Award,
  BookOpenText,
  BookSearch,
  Bot,
  FileUp,
  FolderInput,
  Highlighter,
  Palette,
  SlidersHorizontal,
  SquareTerminal,
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
        body: "把 PDF 拖进窗口即可导入，也可以在「导入论文」中点「选择 PDF 文件」。论文导入后先在本地解析，默认不超过 50 页时自动翻译。可在「设置 → 论文库」调整页数阈值，0 表示全部手动翻译。",
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
  {
    id: "ai-reading",
    title: "AI 深度阅读",
    icon: BookSearch,
    steps: [
      {
        id: "research",
        title: "AI 自主检索原文",
        body: "使用 Codex 或支持工具调用的 API 模型时，AI 会根据问题自己查看目录、检索原文并补读相关章节，侧栏会显示它正在检索的关键词和阅读位置。点击回答下方的「引用原文」，可以跳回原文并高亮对应段落。",
        scene: "research",
      },
      {
        id: "pages",
        title: "查看 PDF 原图与思考过程",
        body: "问到图表、表格或公式时，具备图片能力的模型会主动查看对应页的 PDF 原图再回答。API 模型返回的思考内容收在「思考过程」里，可展开查看，不混入回答正文。",
        scene: "pages",
      },
      {
        id: "overview",
        title: "生成文档概要",
        body: "点击阅读工具栏的书本图标，或在书库中右键选择「文档概要」，即可生成概要、主要内容、限制和原文术语。长文档会分段汇总，结果会保存下来，AI 回答时可以复用。也可以在「设置 → 阅读」中开启导入后自动生成。",
        scene: "overview",
      },
    ],
  },
  {
    id: "collect",
    title: "收录与迁移",
    icon: FolderInput,
    action: { kind: "import", label: "导入论文" },
    steps: [
      {
        id: "zotero",
        title: "从 Zotero 迁移",
        body: "在「导入论文」中点击「从 Zotero 导入」，选择 Zotero 资料目录并扫描，预览后可导入 PDF、论文信息、分类、标签、笔记和可转换的批注。扫描前请完全退出 Zotero；Zotero 中的原数据保持不变。",
        scene: "zotero",
      },
      {
        id: "connector",
        title: "从浏览器收录",
        body: "从 Chrome 网上应用店安装 Reader Connector。在论文页面点击插件图标，选择分类和标签后即可把 PDF 收录到论文库。收录时需要保持 Reader 打开。",
        scene: "connector",
      },
    ],
  },
  {
    id: "notes",
    title: "批注与导出",
    icon: Highlighter,
    steps: [
      {
        id: "hover-note",
        title: "悬停查看批注",
        body: "阅读 EPUB 原文或译文时，将鼠标移到带笔记的高亮上，旁边会直接显示笔记内容，点击铅笔图标即可编辑。",
        scene: "hoverNote",
      },
      {
        id: "export-pdf",
        title: "导出带批注的 PDF",
        body: "在书库中右键 PDF 并选择「导出带批注的 PDF」，或在笔记栏的导出中选择该项。Reader 会将高亮、下划线、笔记以及问题和回答写入 PDF 副本，原文件保持不变。",
        scene: "exportPdf",
      },
    ],
  },
  {
    id: "appearance",
    title: "阅读外观",
    icon: Palette,
    action: { kind: "settings", label: "打开设置" },
    steps: [
      {
        id: "themes",
        title: "石墨与纯黑阅读",
        body: "点击阅读工具栏中的「阅读外观」，可在浅色、纸张、石墨和纯黑之间切换，PDF 原文也会随之换色；选择「跟随系统」后，可分别指定系统浅色和深色时使用的配色。原文缩放、译文字号和 Agent 字号都可以用滑块调整。深色模式下的图片处理方式可在「设置 → 显示」中选择。",
        scene: "appearance",
      },
    ],
  },
  {
    id: "journal-ranks",
    title: "期刊评级",
    icon: Award,
    action: { kind: "settings", label: "打开设置" },
    steps: [
      {
        id: "ranks",
        title: "在论文库查看期刊评级",
        body: "在「设置 → 论文库」的期刊指标中填写 easyScholar SecretKey 并保存，论文标题旁就会显示 CCF、SCI 分区、中科院分区、影响因子等指标。可以只显示选中的指标，不需要时关闭即可。",
        scene: "ranks",
      },
    ],
  },
  {
    id: "cli",
    title: "命令行",
    icon: SquareTerminal,
    action: { kind: "settings", label: "打开设置" },
    steps: [
      {
        id: "cli",
        title: "安装 reader 命令",
        body: "在「设置 → Agent → 命令行工具」中安装 reader 命令后，可以在终端检索、阅读和导入书库中的文档，也可以让 Claude Code、Codex 等 Agent 直接调用。使用时需要保持 Reader 打开。",
        scene: "cli",
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
