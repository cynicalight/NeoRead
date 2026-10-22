// Guide demonstrations. Each scene scripts the pointer, then draws the
// simplified interface for any moment of that script.
import {
  center,
  script,
  sceneSize,
  type Frame,
  type Rect,
  type Scene,
} from "./canvas";
import {
  badge,
  button,
  callout,
  card,
  checkbox,
  checks,
  chevronRight,
  chrome,
  dialog,
  glyphs,
  input,
  libraryHeader,
  main,
  menu,
  paperRow,
  paperTitles,
  paragraph,
  providerMark,
  select,
  sidebar,
  sidebarRects,
  slider,
  sparkle,
  tabRects,
  tabs,
  toast,
  tooltip,
  wrap,
  type CheckState,
} from "./mock";

const scene = (s: Omit<Scene, "width" | "height">): Scene => ({
  ...sceneSize,
  ...s,
});

/** The paper library behind dialogs. */
function library(
  f: Frame,
  rows = paperTitles.slice(0, 4),
  shift = 0,
  active?: number,
) {
  sidebar(f);
  card(f);
  libraryHeader(f);
  rows.forEach((title, i) =>
    paperRow(
      f,
      main.y + 60 + i * 46 + shift,
      title,
      [
        "Kaplan et al. · 2020",
        "Ho et al. · 2020",
        "Brown et al. · 2020",
        "He et al. · 2016",
        "Devlin et al. · 2019",
      ][i % 5],
      { highlight: i === active ? 1 : 0 },
    ),
  );
}

// Settings dialog.
const D: Rect = { x: 92, y: 30, w: 456, h: 344 };
const settingsTabs = { x: D.x + 20, y: D.y + 46, w: 280, h: 28 };
const refreshButton = { x: D.x + D.w - 42, y: D.y + 88, w: 22, h: 22 };
const sdkSelect = { x: D.x + 20, y: D.y + 136, w: D.w - 40, h: 26 };
const cardW = (D.w - 50) / 2;
const agentCards = [0, 1, 2, 3].map((i) => ({
  x: D.x + 20 + (i % 2) * (cardW + 10),
  y: D.y + 176 + Math.floor(i / 2) * 80,
  w: cardW,
  h: 70,
}));
const providers = [
  { name: "Codex", mark: "C", tint: "#10a37f" },
  { name: "Claude Code", mark: "*", tint: "#d97757" },
  { name: "Kimi", mark: "K", tint: "#3b3b3b" },
  { name: "API", mark: "API", tint: "#6366f1" },
];

function settingsFrame(f: Frame, title = "设置") {
  const { p, c } = f;
  p.text(title, D.x + 22, D.y + 25, { size: 14, weight: 600 });
  p.line(
    D.x + D.w - 24,
    D.y + 19,
    D.x + D.w - 16,
    D.y + 27,
    c.mutedForeground,
    1.3,
  );
  p.line(
    D.x + D.w - 16,
    D.y + 19,
    D.x + D.w - 24,
    D.y + 27,
    c.mutedForeground,
    1.3,
  );
}

type CardState = {
  badge?: string;
  checks?: [CheckState, CheckState];
  note?: string;
};

function agentPanel(f: Frame, sdk: string, states: CardState[]) {
  const { p, c } = f;
  settingsFrame(f);
  tabs(f, settingsTabs, ["Agent", "显示", "阅读", "论文库"], 0);
  p.text("Agent 连接", D.x + 22, D.y + 99, { size: 12, weight: 600 });
  button(f, refreshButton, "", "ghost", { icon: glyphs.refresh });
  p.text("Agent SDK", D.x + 22, D.y + 124, { size: 11.5 });
  select(f, sdkSelect, sdk);
  agentCards.forEach((r, i) => {
    const state = states[i];
    const provider = providers[i];
    p.box(r, {
      stroke: c.border,
      radius: 10,
      fill: i === 3 && f.hover(r) ? c.accent : undefined,
    });
    providerMark(f, r.x + 12, r.y + 12, provider.mark, provider.tint);
    p.text(provider.name, r.x + 42, r.y + 23, { size: 12.5, weight: 600 });
    if (state.badge) badge(f, r.x + r.w - 12, r.y + 23, state.badge);
    if (state.checks) checks(f, r.x + 14, r.y + 52, state.checks);
    if (state.note)
      p.text(state.note, r.x + 14, r.y + 52, {
        size: 10.5,
        color: c.mutedForeground,
      });
  });
}

/** Text then image checks that pass after a delay. */
function checking(
  f: Frame,
  mark: string,
  delay: number,
): [CheckState, CheckState] {
  if (!f.after(mark)) return ["passed", "passed"];
  const since = f.since(mark);
  return [
    since < delay ? "pending" : "passed",
    since < delay + 450 ? "pending" : "passed",
  ];
}

const sdkOptions = ["Codex", "Claude Code", "Kimi", "API"];
const menuRow = (x: number, y: number, w: number, i: number) => ({
  x: x + 4,
  y: y + 4 + i * 26,
  w: w - 8,
  h: 24,
});

const detectScript = script({ x: 470, y: 250 })
  .wait(500)
  .move(sidebarRects.settings, 800)
  .click("open")
  .wait(2000)
  .move(refreshButton, 700)
  .wait(500)
  .click("recheck")
  .wait(1700)
  .move(sdkSelect, 650)
  .click("sdk")
  .wait(350)
  .move(menuRow(sdkSelect.x, sdkSelect.y + 30, sdkSelect.w, 1), 500)
  .click("pick")
  .build(1800);

const detect = scene({
  script: detectScript,
  draw(f) {
    library(f);
    const open = f.progress("open", 220);
    dialog(f, D, open, () => {
      const first = !f.after("recheck");
      const states: CardState[] = [
        {
          checks: first
            ? checking(f, "open", 900)
            : checking(f, "recheck", 700),
        },
        {
          checks: first
            ? checking(f, "open", 1300)
            : checking(f, "recheck", 900),
        },
        { badge: "未安装" },
        { badge: "未配置", note: "点击卡片配置你的 API Key" },
      ];
      agentPanel(f, f.after("pick") ? "Claude Code" : "Codex", states);
      if (f.hover(refreshButton))
        tooltip(
          f,
          center(refreshButton).x,
          refreshButton.y - 2,
          "重新检测 Agent",
        );
      if (f.between("sdk", "pick"))
        menu(f, sdkSelect.x, sdkSelect.y + 30, sdkSelect.w, sdkOptions, {
          appear: f.progress("sdk", 150),
          selected: "Codex",
        });
    });
  },
});

// Terminal login, then a recheck in Reader.
const term: Rect = { x: 22, y: 46, w: 360, h: 300 };
const loginPanel: Rect = { x: 400, y: 96, w: 220, h: 170 };
const loginRefresh = {
  x: loginPanel.x + loginPanel.w - 34,
  y: loginPanel.y + 12,
  w: 22,
  h: 22,
};

const loginCommand = "claude auth login";

const loginScript = script({ x: 200, y: 372 })
  .wait(400)
  .move({ x: 210, y: 210 }, 600)
  .click("focus")
  .wait(200)
  .type("cmd", loginCommand)
  .wait(400)
  .mark("browser")
  .wait(1300)
  .mark("done")
  .wait(800)
  .move(loginRefresh, 800)
  .click("recheck")
  .wait(1600)
  .build(1800);

const terminalLines = (f: Frame) => {
  const lines: TerminalLine[] = [
    { text: `~ % ${f.typed(loginCommand, "cmd")}` },
  ];
  if (f.after("browser"))
    lines.push({ text: "Opening browser to sign in…", color: "#a1a1aa" });
  if (f.after("done")) {
    lines.push({ text: "Login successful.", color: "#4ade80" });
    lines.push({ text: "~ % " });
  }
  return lines;
};

interface TerminalLine {
  text: string;
  color?: string;
}

/** A dark terminal window; the block cursor follows the last line. */
function terminal(f: Frame, r: Rect, lines: TerminalLine[], focus: boolean) {
  const { p, c } = f;
  p.text("终端", r.x, 36, { size: 11, weight: 600, color: c.mutedForeground });
  p.box(r, { fill: "#18181b", radius: 10, shadow: 14 });
  p.box({ x: r.x, y: r.y, w: r.w, h: 26 }, { fill: "#27272a", radius: 10 });
  p.box({ x: r.x, y: r.y + 16, w: r.w, h: 10 }, { fill: "#27272a", radius: 0 });
  ["#ff5f57", "#febc2e", "#28c840"].forEach((color, i) =>
    p.circle(r.x + 14 + i * 13, r.y + 13, 4, color),
  );
  p.text("zsh", r.x + r.w / 2, r.y + 13, {
    size: 10.5,
    align: "center",
    color: "#a1a1aa",
  });
  lines.forEach((line, i) =>
    p.text(line.text, r.x + 14, r.y + 46 + i * 20, {
      size: 11,
      mono: true,
      color: line.color ?? "#f4f4f5",
      max: r.w - 28,
    }),
  );
  const last = lines.length - 1;
  if (focus && Math.floor(f.t / 500) % 2 === 0) {
    const x = r.x + 14 + p.measure(lines[last].text, 11, 400, true) + 2;
    p.box(
      { x, y: r.y + 39 + last * 20, w: 6, h: 14 },
      { fill: "#f4f4f5", radius: 1 },
    );
  }
}

const login = scene({
  script: loginScript,
  draw(f) {
    const { p, c } = f;
    chrome(f);
    terminal(f, term, terminalLines(f), f.after("focus"));

    p.text("Reader", loginPanel.x, 36, {
      size: 11,
      weight: 600,
      color: c.mutedForeground,
    });
    p.box(loginPanel, { fill: c.popover, radius: 12, shadow: 14 });
    p.text("Agent 连接", loginPanel.x + 16, loginPanel.y + 23, {
      size: 12,
      weight: 600,
    });
    button(f, loginRefresh, "", "ghost", { icon: glyphs.refresh });
    const r = {
      x: loginPanel.x + 14,
      y: loginPanel.y + 46,
      w: loginPanel.w - 28,
      h: 72,
    };
    p.box(r, { stroke: c.border, radius: 10 });
    providerMark(f, r.x + 12, r.y + 12, "*", "#d97757");
    p.text("Claude Code", r.x + 42, r.y + 23, { size: 12.5, weight: 600 });
    const state: [CheckState, CheckState] = f.after("recheck")
      ? checking(f, "recheck", 700)
      : ["failed", "failed"];
    checks(f, r.x + 14, r.y + 52, state);
    if (f.hover(loginRefresh))
      tooltip(f, center(loginRefresh).x, loginRefresh.y - 2, "重新检测 Agent");
    if (!f.after("recheck"))
      p.text("登录后回到这里重新检测", loginPanel.x + 16, loginPanel.y + 140, {
        size: 10.5,
        color: c.mutedForeground,
      });
    else
      p.alpha(f.progress("recheck", 300, 1200), () =>
        p.text("可以开始使用了", loginPanel.x + 16, loginPanel.y + 140, {
          size: 10.5,
          color: c.success,
        }),
      );
  },
});

// API key.
const urlInput = { x: D.x + 20, y: D.y + 62, w: D.w - 40, h: 28 };
const keyInput = { x: D.x + 20, y: D.y + 98, w: D.w - 100, h: 28 };
const saveButton = { x: D.x + D.w - 72, y: D.y + 98, w: 52, h: 28 };
const apiURL = "https://api.example.com/v1";
const apiKey = "sk-4f9c2a7e1b0d";
const apiModels = ["model-pro", "model-flash", "model-vision"];

const apiScript = script({ x: 560, y: 380 })
  .wait(400)
  .move(agentCards[3], 800)
  .click("api")
  .wait(500)
  .move(urlInput, 500)
  .click("urlFocus")
  .type("url", apiURL)
  .wait(300)
  .move(keyInput, 450)
  .click("keyFocus")
  .type("key", apiKey)
  .wait(300)
  .move(saveButton, 500)
  .click("save")
  .wait(2600)
  .build(1800);

const apiScene = scene({
  script: apiScript,
  draw(f) {
    const { p, c } = f;
    library(f);
    dialog(f, D, 1, () => {
      if (!f.after("api", 120)) {
        agentPanel(f, "Codex", [
          { checks: ["passed", "passed"] },
          { checks: ["passed", "passed"] },
          { badge: "未安装" },
          { badge: "未配置", note: "点击卡片配置你的 API Key" },
        ]);
        return;
      }
      p.alpha(f.progress("api", 200, 120), () => {
        settingsFrame(f, "");
        glyphs.back(f, D.x + 24, D.y + 25, c.foreground);
        p.text("API 配置", D.x + 34, D.y + 25, { size: 14, weight: 600 });
        const url = f.typed(apiURL, "url");
        input(f, urlInput, url, {
          placeholder: "https://api.deepseek.com",
          focus: f.between("urlFocus", "keyFocus"),
        });
        input(f, keyInput, f.typed(apiKey, "key"), {
          placeholder: "API Key",
          focus: f.between("keyFocus", "save"),
          secret: true,
        });
        button(f, saveButton, "保存", "outline");
        if (!f.after("save", 300)) return;
        p.alpha(f.progress("save", 250, 300), () => {
          p.text("模型", D.x + 22, D.y + 152, { size: 12, weight: 600 });
          apiModels.forEach((name, i) => {
            const y = D.y + 182 + i * 32;
            p.text(name, D.x + 22, y, { size: 11.5 });
            const since = f.since("save") - 500 - i * 350;
            const vision = i === 1 ? "failed" : "passed";
            checks(f, D.x + D.w - 175, y, [
              since < 0 ? "pending" : "passed",
              since < 450 ? "pending" : vision,
            ]);
            p.line(D.x + 20, y + 16, D.x + D.w - 20, y + 16, c.border);
          });
        });
      });
    });
  },
});

// Task models.
const modelRows = { chat: D.y + 186, translation: D.y + 222 };
const translationModel = {
  x: D.x + 64,
  y: modelRows.translation - 13,
  w: 246,
  h: 26,
};
const translationEffort = {
  x: D.x + 320,
  y: modelRows.translation - 13,
  w: D.w - 340,
  h: 26,
};
const codexModels = ["GPT-6.1-Sol", "GPT-6-Terra", "GPT-6-Luna"];
const effortOptions = ["Low", "Medium", "High"];

const modelsScript = script({ x: 560, y: 380 })
  .wait(500)
  .move(translationModel, 800)
  .click("models")
  .wait(400)
  .move(
    menuRow(translationModel.x, translationModel.y + 30, translationModel.w, 2),
    550,
  )
  .click("luna")
  .wait(500)
  .move(translationEffort, 600)
  .click("efforts")
  .wait(350)
  .move(
    menuRow(
      translationEffort.x,
      translationEffort.y + 30,
      translationEffort.w,
      0,
    ),
    450,
  )
  .click("low")
  .wait(300)
  .mark("tip")
  .wait(500)
  .mark("tipShown")
  .wait(1700)
  .build(1400);

const models = scene({
  script: modelsScript,
  still: "tipShown",
  draw(f) {
    const { p, c } = f;
    library(f);
    dialog(f, D, 1, () => {
      settingsFrame(f);
      tabs(f, settingsTabs, ["Agent", "显示", "阅读", "论文库"], 0);
      p.text("Agent 连接", D.x + 22, D.y + 99, { size: 12, weight: 600 });
      p.text("Agent SDK", D.x + 22, D.y + 124, { size: 11.5 });
      select(f, sdkSelect, "Codex");
      const luna = f.after("luna");
      const low = f.after("low");
      p.text("问答", D.x + 22, modelRows.chat, { size: 11.5 });
      select(f, { ...translationModel, y: modelRows.chat - 13 }, "GPT-6.1-Sol");
      select(f, { ...translationEffort, y: modelRows.chat - 13 }, "Medium");
      p.text("翻译", D.x + 22, modelRows.translation, { size: 11.5 });
      select(f, translationModel, luna ? "GPT-6-Luna" : "GPT-6.1-Sol", {
        open: f.between("models", "luna"),
      });
      select(f, translationEffort, low ? "Low" : "Medium", {
        open: f.between("efforts", "low"),
      });
      paragraph(
        f,
        "问答与翻译分别使用上方模型；未指定时，问答使用主力模型，翻译使用快速模型。",
        D.x + 22,
        D.y + 306,
        D.w - 44,
        { size: 10.5, color: c.mutedForeground },
      );
      if (f.after("tip"))
        callout(
          f,
          translationModel.x + 40,
          translationModel.y + 32,
          "翻译选最快的模型就够了",
          f.progress("tip", 250),
        );
      if (f.between("models", "luna"))
        menu(
          f,
          translationModel.x,
          translationModel.y + 30,
          translationModel.w,
          codexModels,
          {
            appear: f.progress("models", 150),
            selected: "GPT-6.1-Sol",
          },
        );
      if (f.between("efforts", "low"))
        menu(
          f,
          translationEffort.x,
          translationEffort.y + 30,
          translationEffort.w,
          effortOptions,
          {
            appear: f.progress("efforts", 150),
            selected: "Medium",
          },
        );
    });
  },
});

// Import by link.
const I: Rect = { x: 170, y: 92, w: 300, h: 214 };
const refInput = { x: I.x + 18, y: I.y + 70, w: I.w - 36 - 72, h: 28 };
const importSubmit = { x: I.x + I.w - 18 - 66, y: I.y + 70, w: 66, h: 28 };
const choosePDF = { x: I.x + 18, y: I.y + 136, w: I.w - 36, h: 26 };
const paperURL = "https://arxiv.org/abs/1706.03762";

function importDialog(
  f: Frame,
  value: string,
  o: { focus?: boolean; busy?: boolean; appear: number },
) {
  const { p, c } = f;
  dialog(f, I, o.appear, () => {
    p.text("导入论文", I.x + 18, I.y + 25, { size: 13.5, weight: 600 });
    p.text(
      "arXiv 编号、DOI、论文页面或 PDF 链接、完整标题",
      I.x + 18,
      I.y + 47,
      {
        size: 10.5,
        color: c.mutedForeground,
        max: I.w - 36,
      },
    );
    input(f, refInput, value, {
      placeholder: "例如 2401.01234 或 10.1145/…",
      focus: o.focus,
    });
    if (o.busy) {
      p.box(importSubmit, { fill: c.primary, radius: 6 });
      p.alpha(0.7, () => {
        p.spinner(
          importSubmit.x + 14,
          importSubmit.y + 14,
          4,
          f.t,
          c.primaryForeground,
        );
        p.text("下载中", importSubmit.x + 24, importSubmit.y + 14, {
          size: 11,
          weight: 500,
          color: c.primaryForeground,
        });
      });
    } else button(f, importSubmit, "导入", "primary");
    p.line(I.x + 18, I.y + 118, I.x + I.w / 2 - 14, I.y + 118, c.border);
    p.line(I.x + I.w / 2 + 14, I.y + 118, I.x + I.w - 18, I.y + 118, c.border);
    p.text("或", I.x + I.w / 2, I.y + 118, {
      size: 10.5,
      align: "center",
      color: c.mutedForeground,
    });
    button(f, choosePDF, "选择 PDF 文件", "outline", { icon: glyphs.file });
    button(
      f,
      { ...choosePDF, y: choosePDF.y + 34 },
      "从 Zotero 导入",
      "outline",
    );
  });
}

/** The library with one new paper sliding in at the top. */
function libraryWithNew(f: Frame, mark: string) {
  const k = f.after(mark) ? f.progress(mark, 450) : 0;
  sidebar(f);
  card(f);
  libraryHeader(f);
  const { p } = f;
  p.ctx.save();
  p.ctx.beginPath();
  p.ctx.rect(main.x, main.y + 50, main.w, main.h - 52);
  p.ctx.clip();
  paperTitles
    .slice(0, 4)
    .forEach((title, i) =>
      paperRow(
        f,
        main.y + 60 + (i + k) * 46,
        title,
        [
          "Kaplan et al. · 2020",
          "Ho et al. · 2020",
          "Brown et al. · 2020",
          "He et al. · 2016",
        ][i],
      ),
    );
  if (k > 0)
    p.alpha(k, () =>
      paperRow(
        f,
        main.y + 60 - (1 - k) * 12,
        "Attention Is All You Need",
        "Vaswani et al. · 2017 · arXiv",
        {
          highlight:
            f.since(mark) < 2200
              ? 1
              : Math.max(0, 1 - (f.since(mark) - 2200) / 600),
        },
      ),
    );
  p.ctx.restore();
}

const linkScript = script({ x: 480, y: 300 })
  .wait(400)
  .move(sidebarRects.importButton, 800)
  .click("open")
  .wait(300)
  .move(refInput, 500)
  .click("focus")
  .type("url", paperURL)
  .wait(300)
  .move(importSubmit, 500)
  .click("submit")
  .wait(1400)
  .mark("done")
  .wait(800)
  .mark("added")
  .wait(1600)
  .build(1400);

const link = scene({
  script: linkScript,
  still: "added",
  draw(f) {
    libraryWithNew(f, "done");
    const appear = f.after("done")
      ? 1 - f.progress("done", 200)
      : f.progress("open", 220);
    importDialog(f, f.typed(paperURL, "url"), {
      appear,
      focus: f.between("focus", "submit"),
      busy: f.after("submit"),
    });
  },
});

// Import a local PDF by dragging it in.
const finder: Rect = { x: 452, y: 236, w: 172, h: 136 };
const pdfFile = { x: finder.x + 62, y: finder.y + 46, w: 48, h: 60 };
const dropPoint = { x: 380, y: 190 };

function pdfIcon(f: Frame, x: number, y: number, label = true) {
  const { p, c } = f;
  p.box(
    { x, y, w: 30, h: 38 },
    { fill: c.background, stroke: c.border, radius: 4, shadow: 4 },
  );
  p.box({ x: x + 4, y: y + 22, w: 22, h: 10 }, { fill: "#e5484d", radius: 2 });
  p.text("PDF", x + 15, y + 27.5, {
    size: 7.5,
    weight: 700,
    align: "center",
    color: "#ffffff",
  });
  if (label)
    p.text("transformer.pdf", x + 15, y + 50, {
      size: 9.5,
      align: "center",
      color: c.foreground,
    });
}

const pdfScript = script({ x: 380, y: 340 })
  .wait(400)
  .move(pdfFile, 700)
  .mark("grab")
  .wait(250)
  .move(dropPoint, 1100)
  .mark("drop")
  .wait(900)
  .mark("imported")
  .wait(1700)
  .build(1200);

const pdf = scene({
  script: pdfScript,
  still: "imported",
  draw(f) {
    const { p, c } = f;
    libraryWithNew(f, "drop");
    // The file comes from another window, which steps back after the drop.
    p.alpha(f.after("drop") ? 1 - f.progress("drop", 300, 200) : 1, () => {
      p.box(finder, {
        fill: c.popover,
        radius: 10,
        shadow: 16,
        stroke: c.border,
      });
      ["#ff5f57", "#febc2e", "#28c840"].forEach((color, i) =>
        p.circle(finder.x + 13 + i * 12, finder.y + 13, 3.5, color),
      );
      p.text("下载", finder.x + finder.w / 2, finder.y + 13, {
        size: 10.5,
        weight: 600,
        align: "center",
      });
      p.line(
        finder.x,
        finder.y + 26,
        finder.x + finder.w,
        finder.y + 26,
        c.border,
      );
      pdfIcon(f, pdfFile.x + 9, pdfFile.y + 4);
    });
    if (f.between("grab", "drop"))
      p.alpha(0.75, () => pdfIcon(f, f.cursor.x - 6, f.cursor.y + 6, false));
    if (f.after("drop", 300))
      toast(
        f,
        "已导入 1 个文件",
        Math.min(
          f.progress("drop", 200, 300),
          1 - f.progress("drop", 300, 2300),
        ),
      );
  },
});

// Reading modes.
const modeTabs = { x: 360, y: 8, w: 222, h: 28 };
const modeLabels = ["仅原文", "原文译文", "仅译文"];
const content: Rect = { x: 8, y: 44, w: 624, h: 348 };
const source =
  "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include an encoder and a decoder. The best performing models also connect the encoder and decoder through an attention mechanism. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely.";
const translation =
  "主流的序列转换模型基于复杂的循环或卷积神经网络，包含编码器和解码器。表现最好的模型还通过注意力机制连接编码器与解码器。我们提出一种新的简单网络架构 Transformer，它完全基于注意力机制，彻底摒弃了循环和卷积。";

function readingToolbar(f: Frame, active: number, o: { width?: number } = {}) {
  const { p, c } = f;
  chrome(f);
  glyphs.back(f, 72, 22, c.mutedForeground);
  p.text("Attention Is All You Need", 84, 22, {
    size: 12,
    weight: 600,
    max: (o.width ?? 270) - 84,
  });
  return tabs(f, modeTabs, modeLabels, active);
}

function sourceText(f: Frame, x: number, width: number, top = 0) {
  const { p, c } = f;
  p.text("Abstract", x, content.y + 30 + top, { size: 13, weight: 600 });
  return paragraph(f, source, x, content.y + 56 + top, width, {
    size: 11.5,
    leading: 20,
    color: c.foreground,
  });
}

function translatedText(f: Frame, x: number, width: number) {
  const { p } = f;
  p.text("摘要", x, content.y + 30, { size: 13, weight: 600 });
  paragraph(f, translation, x, content.y + 56, width, {
    size: 11.5,
    leading: 20,
    weight: 600,
  });
}

const modeScript = script({ x: 470, y: 230 })
  .wait(900)
  .move(tabRects(modeTabs, 3)[1], 700)
  .click("parallel")
  .wait(1300)
  .mark("parallelShown")
  .wait(900)
  .move(tabRects(modeTabs, 3)[2], 500)
  .click("translation")
  .wait(2000)
  .move(tabRects(modeTabs, 3)[0], 500)
  .click("source")
  .wait(400)
  .build(1400);

const modes = scene({
  script: modeScript,
  still: "parallelShown",
  draw(f) {
    const { p, c } = f;
    const mode = f.after("source")
      ? 0
      : f.after("translation")
        ? 2
        : f.after("parallel")
          ? 1
          : 0;
    const changed = ["source", "translation", "parallel"].find(
      (m) => f.after(m) && f.since(m) < 260,
    );
    readingToolbar(f, mode);
    card(f, content);
    p.alpha(changed ? f.progress(changed, 260) : 1, () => {
      if (mode === 0) sourceText(f, content.x + 110, content.w - 220);
      if (mode === 2) translatedText(f, content.x + 110, content.w - 220);
      if (mode === 1) {
        const half = content.w / 2;
        sourceText(f, content.x + 26, half - 46);
        p.line(
          content.x + half,
          content.y + 16,
          content.x + half,
          content.y + content.h - 16,
          c.border,
        );
        translatedText(f, content.x + half + 20, half - 46);
      }
    });
  },
});

// AI assistant.
const page: Rect = { x: 8, y: 44, w: 410, h: 348 };
const side: Rect = { x: 426, y: 44, w: 206, h: 348 };
const textX = page.x + 28;
const textWidth = page.w - 56;
const lineY = (i: number) => page.y + 56 + i * 20;
const pageText =
  "We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely. Experiments on two machine translation tasks show these models to be superior in quality while being more parallelizable and requiring significantly less time to train.";
const selectionStart = { x: textX, y: lineY(0) };
const selectionEnd = { x: textX + textWidth, y: lineY(1) };
const toolbarRect = {
  x: textX + textWidth / 2 - 92,
  y: lineY(0) - 46,
  w: 184,
  h: 30,
};
const toolIcons = ["高亮", "下划线", "添加批注", "提问", "问 AI", "引用到对话"];
const toolRect = (i: number) => ({
  x: toolbarRect.x + 6 + i * 29,
  y: toolbarRect.y + 3,
  w: 26,
  h: 24,
});
const askRect = toolRect(4);
const chatInput = {
  x: side.x + 10,
  y: side.y + side.h - 46,
  w: side.w - 20,
  h: 36,
};
const sendRect = {
  x: chatInput.x + chatInput.w - 28,
  y: chatInput.y + 7,
  w: 22,
  h: 22,
};
const question = "这个结论有什么前提？";
const answers = [
  "这句话说明 Transformer 只依靠注意力机制建模序列关系，不再使用循环或卷积结构。依据是摘要对新架构的描述。",
  "前提是注意力足以捕捉长距离依赖；作者在两个机器翻译任务上的实验支持了这一点。",
];
const streamSpeed = 28;

const assistantScript = script({ x: 300, y: 330 })
  .wait(400)
  .move(selectionStart, 650)
  .mark("down")
  .move(selectionEnd, 1000)
  .mark("up")
  .wait(350)
  .move(askRect, 600)
  .wait(450)
  .click("ask")
  .wait(answers[0].length * streamSpeed + 900)
  .move(chatInput, 700)
  .click("focus")
  .type("question", question)
  .wait(250)
  .move(sendRect, 350)
  .click("send")
  .wait(answers[1].length * streamSpeed + 1400)
  .build(1600);

interface Message {
  text: string;
  user?: boolean;
  quote?: string;
}
const messageText = { size: 10.5, leading: 16 };

function messageHeight(f: Frame, m: Message, width: number) {
  const lines = m.text
    ? wrap(f, m.text, width - 20, messageText.size).length
    : 0;
  return (m.quote ? 22 : 0) + lines * messageText.leading + 14;
}

function message(f: Frame, m: Message, x: number, y: number, width: number) {
  const { p, c } = f;
  const h = messageHeight(f, m, width);
  if (m.user) p.box({ x, y, w: width, h }, { fill: c.muted, radius: 9 });
  let top = y + 7;
  if (m.quote) {
    p.line(x + 10, top + 1, x + 10, top + 13, c.mutedForeground, 2);
    p.text(m.quote, x + 17, top + 7, {
      size: 9.5,
      color: c.mutedForeground,
      max: width - 28,
    });
    top += 22;
  }
  if (m.text)
    paragraph(f, m.text, x + 10, top + 7, width - 20, { ...messageText });
  return h;
}

const streamed = (f: Frame, text: string, mark: string) =>
  text.slice(0, Math.max(0, Math.floor((f.since(mark) - 500) / streamSpeed)));

/** Selected text grows with the pointer while dragging. */
function selection(f: Frame, lines: string[]) {
  const { p, c } = f;
  if (!f.after("down")) return;
  const done = f.after("up");
  const ends = [0, 1].map((i) => textX + p.measure(lines[i] ?? "", 11.5));
  const second = done || f.cursor.y > lineY(0) + 10;
  const spans = second
    ? [ends[0], done ? ends[1] : Math.min(ends[1], f.cursor.x)]
    : [Math.min(ends[0], Math.max(textX, f.cursor.x))];
  spans.forEach((end, i) =>
    p.box(
      {
        x: textX - 1,
        y: lineY(i) - 10,
        w: Math.max(0, end - textX + 2),
        h: 20,
      },
      {
        fill: c.dark ? "rgb(96 165 250 / 35%)" : "rgb(59 130 246 / 22%)",
        radius: 2,
      },
    ),
  );
}

function selectionToolbar(f: Frame) {
  const { p, c } = f;
  toolIcons.forEach((label, i) => {
    const r = toolRect(i);
    if (f.hover(r)) p.box(r, { fill: c.accent, radius: 5 });
    const x = r.x + r.w / 2;
    const y = r.y + r.h / 2;
    if (i === 0) {
      p.circle(x - 5, y, 3.2, "#facc15");
      p.circle(x + 1, y, 3.2, "#4ade80");
      p.circle(x + 7, y, 3.2, "#60a5fa");
    } else if (i === 1) {
      p.text("U", x, y - 1, { size: 11, weight: 600, align: "center" });
      p.line(x - 4, y + 6, x + 4, y + 6, c.foreground, 1.2);
    } else if (i === 2) glyphs.file(f, x, y, c.foreground);
    else if (i === 3)
      p.text("?", x, y, { size: 12, weight: 600, align: "center" });
    else if (i === 4) sparkle(f, x, y, 6, c.foreground);
    else p.text("“", x, y + 3, { size: 16, weight: 600, align: "center" });
  });
  toolIcons.forEach((label, i) => {
    const r = toolRect(i);
    if (f.hover(r)) tooltip(f, r.x + r.w / 2, r.y - 2, label);
  });
}

/** The reading window's title bar. */
function readerTop(f: Frame, title = "Attention Is All You Need") {
  chrome(f);
  glyphs.back(f, 72, 22, f.c.mutedForeground);
  f.p.text(title, 84, 22, { size: 12, weight: 600, max: 220 });
}

/** The Agent sidebar with its tabs. */
function assistantSide(f: Frame) {
  card(f, side);
  tabs(
    f,
    { x: side.x + 10, y: side.y + 10, w: 130, h: 26 },
    ["Agent", "批注"],
    0,
  );
}

const sideHint = (f: Frame) =>
  paragraph(
    f,
    "选中原文，可以翻译、解释，或引用多段文字一起讨论。",
    side.x + 16,
    side.y + 140,
    side.w - 32,
    { size: 10.5, leading: 17, color: f.c.mutedForeground },
  );

/** The question box at the bottom of the Agent sidebar. */
function composer(
  f: Frame,
  value: string,
  o: { focus: boolean; ready: boolean },
) {
  const { p, c } = f;
  input(f, chatInput, value, { placeholder: "向 AI 提问", focus: o.focus });
  const s = center(sendRect);
  p.circle(s.x, s.y, 11, o.ready ? c.primary : c.muted);
  glyphs.send(f, s.x, s.y, o.ready ? c.primaryForeground : c.mutedForeground);
}

const assistant = scene({
  script: assistantScript,
  draw(f) {
    const { p, c } = f;
    readerTop(f);
    card(f, page);
    const lines = wrap(f, pageText, textWidth, 11.5);
    selection(f, lines);
    p.text("Abstract", textX, page.y + 30, { size: 13, weight: 600 });
    paragraph(f, pageText, textX, lineY(0), textWidth, {
      size: 11.5,
      leading: 20,
    });
    if (f.after("up") && !f.after("ask", 200))
      p.alpha(
        f.progress("up", 160) *
          (f.after("ask") ? 1 - f.progress("ask", 200) : 1),
        () => {
          p.box(toolbarRect, {
            fill: c.popover,
            radius: 8,
            shadow: 12,
            stroke: c.border,
          });
          selectionToolbar(f);
        },
      );
    assistantSide(f);
    if (!f.after("ask")) sideHint(f);
    else {
      const width = side.w - 20;
      const messages: Message[] = [
        {
          text: "请解释这段文字的含义。",
          user: true,
          quote: `${lines[0]} ${lines[1] ?? ""}`,
        },
        { text: streamed(f, answers[0], "ask") },
      ];
      if (f.after("send"))
        messages.push(
          { text: question, user: true },
          { text: streamed(f, answers[1], "send") },
        );
      const top = side.y + 46;
      const bottom = chatInput.y - 12;
      const total = messages.reduce(
        (sum, m) => sum + messageHeight(f, m, width) + 10,
        0,
      );
      // Keep the newest text in view, as the chat scrolls.
      let y = top - Math.max(0, total - (bottom - top));
      p.ctx.save();
      p.ctx.beginPath();
      p.ctx.rect(side.x, top - 4, side.w, bottom - top + 4);
      p.ctx.clip();
      for (const m of messages) y += message(f, m, side.x + 10, y, width) + 10;
      p.ctx.restore();
    }
    composer(f, f.after("send") ? "" : f.typed(question, "question"), {
      focus: f.between("focus", "send"),
      ready: f.after("question") && !f.after("send"),
    });
  },
});

// Agent activity, as the sidebar shows it while a model reads.
function notice(f: Frame, text: string, y: number, appear = 1) {
  const { p, c } = f;
  const x = side.x + 14;
  p.alpha(appear, () => {
    glyphs.book(f, x + 5, y, c.mutedForeground);
    paragraph(f, text, x + 18, y, side.w - 46, {
      size: 10,
      leading: 15,
      color: c.mutedForeground,
    });
  });
}

/** A clickable source under an answer. */
function sourceCard(f: Frame, r: Rect, label: string, excerpt: string) {
  const { p, c } = f;
  p.box(r, {
    fill: f.hover(r) ? c.accent : c.background,
    stroke: c.border,
    radius: 8,
  });
  p.text(`引用原文 · ${label}`, r.x + 10, r.y + 14, {
    size: 9.5,
    weight: 500,
    color: c.mutedForeground,
    max: r.w - 34,
  });
  glyphs.external(f, r.x + r.w - 14, r.y + 14, c.mutedForeground);
  p.text(excerpt, r.x + 10, r.y + 32, { size: 10, max: r.w - 20 });
}

const answerText = (f: Frame, text: string, y: number) =>
  paragraph(f, text, side.x + 14, y, side.w - 28, messageText);

// The agent searches and reads the document on its own.
const researchQuestion = "作者用了哪些正则化方法？";
const researchSteps = [
  "正在查看文档目录 · 定位相关章节",
  "正在检索“regularization” · 查找相关原文",
  "正在阅读 5.4 Regularization · 阅读章节原文",
];
const researchAnswer =
  "作者用了两种正则化：对每个子层的输出和嵌入求和施加残差 Dropout，比例为 0.1；训练时再使用 0.1 的标签平滑。";
const regularization =
  "Residual Dropout. We apply dropout to the output of each sub-layer, before it is added to the sub-layer input and normalized. In addition, we apply dropout to the sums of the embeddings and the positional encodings. Label Smoothing. During training, we employed label smoothing of value 0.1.";
const answerTop = side.y + 92;
const researchCard = { x: side.x + 10, y: side.y + 200, w: side.w - 20, h: 46 };

const researchScript = script({ x: 300, y: 330 })
  .wait(400)
  .move(chatInput, 700)
  .click("focus")
  .type("question", researchQuestion)
  .wait(250)
  .move(sendRect, 400)
  .click("send")
  .wait(300)
  .mark("step0")
  .wait(1200)
  .mark("step1")
  .wait(1200)
  .mark("step2")
  .wait(1200)
  .mark("answer")
  .wait(researchAnswer.length * streamSpeed + 700)
  .mark("sources")
  .wait(400)
  .move(researchCard, 700)
  .wait(300)
  .click("jump")
  .wait(2400)
  .build(1400);

const research = scene({
  script: researchScript,
  draw(f) {
    const { p, c } = f;
    readerTop(f);
    card(f, page);
    const jumped = f.after("jump");
    p.alpha(jumped ? f.progress("jump", 300) : 1, () => {
      if (!jumped) {
        p.text("Abstract", textX, page.y + 30, { size: 13, weight: 600 });
        paragraph(f, pageText, textX, lineY(0), textWidth, {
          size: 11.5,
          leading: 20,
        });
        return;
      }
      p.text("5.4 Regularization", textX, page.y + 30, {
        size: 13,
        weight: 600,
      });
      // The source block flashes after the jump.
      const lines = wrap(f, regularization, textWidth, 11.5).length;
      p.alpha(
        f.since("jump") < 300
          ? f.progress("jump", 300)
          : 1 - f.progress("jump", 900, 1300),
        () =>
          p.box(
            {
              x: textX - 8,
              y: lineY(0) - 14,
              w: textWidth + 16,
              h: lines * 20 + 8,
            },
            {
              fill: c.dark ? "rgb(250 204 21 / 22%)" : "rgb(250 204 21 / 30%)",
              radius: 6,
            },
          ),
      );
      paragraph(f, regularization, textX, lineY(0), textWidth, {
        size: 11.5,
        leading: 20,
      });
    });
    assistantSide(f);
    if (!f.after("send")) sideHint(f);
    else {
      message(
        f,
        { text: researchQuestion, user: true },
        side.x + 10,
        side.y + 46,
        side.w - 20,
      );
      const text = f.after("answer")
        ? streamed(f, researchAnswer, "answer")
        : "";
      const step = ["step2", "step1", "step0"].find((m) => f.after(m));
      if (text) answerText(f, text, answerTop);
      else if (step)
        notice(
          f,
          researchSteps[Number(step.slice(4))],
          answerTop,
          f.progress(step, 200),
        );
      if (f.after("sources"))
        p.alpha(f.progress("sources", 250), () =>
          sourceCard(
            f,
            researchCard,
            "5.4 Regularization",
            "We apply dropout to the output of each sub-layer…",
          ),
        );
    }
    composer(f, f.after("send") ? "" : f.typed(researchQuestion, "question"), {
      focus: f.between("focus", "send"),
      ready: f.after("question") && !f.after("send"),
    });
  },
});

// A PDF page, drawn in the given ink so reading themes can recolor it.
interface Ink {
  paper: string;
  text: string;
  bar: string;
}
const lightInk: Ink = { paper: "#ffffff", text: "#27272a", bar: "#d4d4d8" };

/** Paints a PDF page and returns where its table sits. */
function pdfPage(f: Frame, r: Rect, ink: Ink) {
  const { p } = f;
  p.box(r, { fill: ink.paper, radius: 3, shadow: 8 });
  const x = r.x + 20;
  const w = r.w - 40;
  p.bars({ x, y: r.y + 20, w, h: 0 }, [1, 0.95, 0.98, 0.62], {
    color: ink.bar,
    gap: 10,
    height: 4,
  });
  // A figure keeps its colors in every theme.
  const fig = { x: x + 8, y: r.y + 66, w: w * 0.6, h: 64 };
  p.line(fig.x, fig.y, fig.x, fig.y + fig.h, ink.text, 1);
  p.line(fig.x, fig.y + fig.h, fig.x + fig.w, fig.y + fig.h, ink.text, 1);
  [0.45, 0.7, 0.95, 0.6, 0.85].forEach((v, i) =>
    p.box(
      {
        x: fig.x + 10 + i * 24,
        y: fig.y + fig.h * (1 - v),
        w: 14,
        h: fig.h * v,
      },
      { fill: ["#3b82f6", "#f97316", "#22c55e"][i % 3], radius: 1.5 },
    ),
  );
  p.text("Figure 3: Training cost", x, fig.y + fig.h + 14, {
    size: 8,
    color: ink.text,
  });
  const table = { x, y: r.y + 172, w, h: 82 };
  p.text("Table 2: BLEU scores", x, table.y - 8, { size: 8, color: ink.text });
  p.line(x, table.y, x + w, table.y, ink.text, 1);
  p.line(x, table.y + 16, x + w, table.y + 16, ink.text, 0.6);
  p.line(x, table.y + table.h, x + w, table.y + table.h, ink.text, 1);
  [0, 1, 2, 3, 4].forEach((row) =>
    [0.4, 0.2, 0.2].forEach((cell, col) =>
      p.box(
        {
          x: x + [0, 0.5, 0.75][col] * w,
          y: table.y + 6 + row * 15 + (row ? 2 : 0),
          w: w * cell * (row === 4 && col ? 0.8 : 0.7),
          h: 4,
        },
        { fill: row === 4 || !row ? ink.text : ink.bar, radius: 2 },
      ),
    ),
  );
  p.bars({ x, y: r.y + 272, w, h: 0 }, [1, 0.92, 0.97, 0.5], {
    color: ink.bar,
    gap: 10,
    height: 4,
  });
  p.text("8", r.x + r.w / 2, r.y + r.h - 10, {
    size: 8,
    align: "center",
    color: ink.text,
  });
  return table;
}

// The model looks at the page image, and its thinking folds away.
const tableQuestion = "表 2 说明了什么？";
const tableThinking =
  "问题针对表 2 的数值，解析出的正文可能丢失表格结构，先查看第 8 页原图再核对。";
const tableAnswer =
  "表 2 显示 Transformer (big) 在英德和英法翻译上分别达到 28.4 和 41.8 BLEU，超过此前所有模型，训练成本却低一个数量级以上。";
const paper: Rect = { x: page.x + 80, y: page.y + 10, w: 250, h: 328 };
const thinkingToggle = { x: side.x + 10, y: side.y + 84, w: 96, h: 22 };

const pagesScript = script({ x: 300, y: 330 })
  .wait(400)
  .move(chatInput, 700)
  .click("focus")
  .type("question", tableQuestion)
  .wait(250)
  .move(sendRect, 400)
  .click("send")
  .wait(300)
  .mark("thinking")
  .wait(1300)
  .mark("viewing")
  .wait(1900)
  .mark("answer")
  .wait(tableAnswer.length * streamSpeed + 800)
  .move(thinkingToggle, 700)
  .click("expand")
  .wait(2600)
  .build(1400);

const pages = scene({
  script: pagesScript,
  draw(f) {
    const { p, c } = f;
    readerTop(f);
    card(f, page);
    const table = pdfPage(f, paper, lightInk);
    const text = f.after("answer") ? streamed(f, tableAnswer, "answer") : "";
    if (f.after("viewing") && !text) {
      // The page image is being read: outline it and sweep over the table.
      const k = ((f.since("viewing") % 1400) / 1400) * 1.2;
      p.alpha(f.progress("viewing", 250), () => {
        p.box(
          { x: paper.x - 4, y: paper.y - 4, w: paper.w + 8, h: paper.h + 8 },
          { stroke: c.ring, radius: 6, line: 2 },
        );
        p.box(
          {
            x: table.x - 6,
            y: table.y - 16 + Math.min(1, k) * (table.h + 4),
            w: table.w + 12,
            h: 18,
          },
          {
            fill: c.dark ? "rgb(96 165 250 / 25%)" : "rgb(59 130 246 / 16%)",
            radius: 3,
          },
        );
      });
    }
    assistantSide(f);
    if (!f.after("send")) sideHint(f);
    else {
      message(
        f,
        { text: tableQuestion, user: true },
        side.x + 10,
        side.y + 46,
        side.w - 20,
      );
      let y = thinkingToggle.y + 34;
      if (f.after("thinking")) {
        const r = thinkingToggle;
        const open = f.after("expand");
        if (f.hover(r)) p.box(r, { fill: c.accent, radius: 6 });
        if (open) p.chevron(r.x + 10, r.y + 11, 7, c.mutedForeground);
        else chevronRight(f, r.x + 10, r.y + 11, c.mutedForeground);
        p.text(text ? "思考过程" : "正在思考…", r.x + 22, r.y + 11, {
          size: 10.5,
          color: c.mutedForeground,
        });
        if (open)
          p.alpha(f.progress("expand", 220), () => {
            const end = paragraph(
              f,
              tableThinking,
              side.x + 22,
              y - 4,
              side.w - 40,
              { size: 10, leading: 15, color: c.mutedForeground },
            );
            p.line(side.x + 14, y - 11, side.x + 14, end - 8, c.border, 2);
            y = end + 6;
          });
      }
      if (text) answerText(f, text, y);
      else if (f.after("viewing"))
        notice(
          f,
          "正在查看第 8 页图像 · 核对图表、公式与版面",
          y,
          f.progress("viewing", 200),
        );
    }
    composer(f, f.after("send") ? "" : f.typed(tableQuestion, "question"), {
      focus: f.between("focus", "send"),
      ready: f.after("question") && !f.after("send"),
    });
  },
});

// Document overview.
const overviewButton = { x: 598, y: 11, w: 24, h: 22 };
const O: Rect = { x: 110, y: 40, w: 420, h: 334 };
const generateButton = { x: O.x + O.w - 112, y: O.y + 64, w: 92, h: 26 };
const overviewSummary =
  "论文提出完全基于注意力机制的 Transformer，用多头自注意力取代循环和卷积，在机器翻译上以更低的训练成本取得更好的结果。";
const overviewFindings = [
  "英德翻译 28.4 BLEU，英法翻译 41.8 BLEU",
  "8 张 P100 训练 3.5 天，成本低于此前模型",
  "同一架构可迁移到英语成分句法分析",
];

const overviewScript = script({ x: 420, y: 300 })
  .wait(400)
  .move(overviewButton, 800)
  .wait(500)
  .click("open")
  .wait(500)
  .move(generateButton, 600)
  .click("generate")
  .wait(2200)
  .mark("done")
  .wait(3000)
  .build(1400);

const overview = scene({
  script: overviewScript,
  draw(f) {
    const { p, c } = f;
    readerTop(f);
    button(f, overviewButton, "", "ghost", { icon: glyphs.book });
    card(f, content);
    sourceText(f, content.x + 110, content.w - 220);
    if (f.hover(overviewButton) && !f.after("open"))
      tooltip(
        f,
        center(overviewButton).x - 14,
        overviewButton.y + 46,
        "文档概要",
      );
    dialog(f, O, f.progress("open", 220), () => {
      glyphs.book(f, O.x + 26, O.y + 25, c.foreground);
      p.text("文档概要", O.x + 38, O.y + 25, { size: 14, weight: 600 });
      p.text("Attention Is All You Need", O.x + 20, O.y + 46, {
        size: 10.5,
        color: c.mutedForeground,
      });
      const running = f.between("generate", "done");
      const done = f.after("done");
      const covered = done
        ? 4
        : Math.min(4, Math.floor(Math.max(0, f.since("generate")) / 550) + 1);
      const status = done
        ? "概要已生成 · 覆盖 4/4 段"
        : running
          ? `正在生成概要 · 覆盖 ${covered - 1}/4 段`
          : "尚未生成概要";
      p.text(status, O.x + 20, generateButton.y + 13, {
        size: 10.5,
        color: c.mutedForeground,
      });
      if (running) {
        p.box(generateButton, {
          fill: c.background,
          stroke: c.border,
          radius: 6,
        });
        p.spinner(
          generateButton.x + 18,
          generateButton.y + 13,
          4.5,
          f.t,
          c.mutedForeground,
        );
        p.text("取消", generateButton.x + 32, generateButton.y + 13, {
          size: 11.5,
          weight: 500,
        });
      } else
        button(f, generateButton, done ? "重新生成" : "生成概要", "outline", {
          icon: glyphs.refresh,
        });
      if (!done) return;
      p.alpha(f.progress("done", 350), () => {
        let y = paragraph(f, overviewSummary, O.x + 20, O.y + 114, O.w - 40, {
          size: 11.5,
          leading: 20,
        });
        p.text("主要内容", O.x + 20, y + 10, { size: 11.5, weight: 600 });
        y += 34;
        overviewFindings.forEach((line, i) => {
          p.circle(O.x + 26, y + i * 20, 1.8, c.mutedForeground);
          p.text(line, O.x + 34, y + i * 20, { size: 11, max: O.w - 54 });
        });
        y += overviewFindings.length * 20 + 6;
        p.text("原文术语", O.x + 20, y, { size: 11.5, weight: 600 });
        p.text(
          "Transformer · Multi-Head Attention · Positional Encoding",
          O.x + 20,
          y + 22,
          { size: 11, color: c.mutedForeground, max: O.w - 40 },
        );
      });
    });
  },
});

// Zotero migration.
const zoteroButton = { ...choosePDF, y: choosePDF.y + 34 };
const Z: Rect = { x: 96, y: 30, w: 448, h: 340 };
const scanButton = { x: Z.x + 18, y: Z.y + 178, w: 96, h: 28 };
const selectAll = { x: Z.x + Z.w - 18 - 84, y: Z.y + 84, w: 84, h: 24 };
const importSelected = { x: Z.x + Z.w - 18 - 112, y: Z.y + 298, w: 112, h: 28 };
const zoteroItems = [
  { title: "Attention Is All You Need", meta: "语言模型 · 3 条批注" },
  {
    title: "Denoising Diffusion Probabilistic Models",
    meta: "生成模型 · 1 条笔记",
  },
  {
    title: "Scaling Laws for Neural Language Models",
    meta: "语言模型 · 标签 2",
  },
  {
    title: "A Survey of Large Language Models",
    meta: "语言模型",
    missing: true,
  },
];

const zoteroScript = script({ x: 480, y: 300 })
  .wait(400)
  .move(sidebarRects.importButton, 800)
  .click("open")
  .wait(300)
  .move(zoteroButton, 600)
  .click("zotero")
  .wait(500)
  .move(scanButton, 700)
  .click("scan")
  .wait(1000)
  .mark("scanned")
  .wait(500)
  .move(selectAll, 600)
  .click("selectAll")
  .wait(400)
  .move(importSelected, 600)
  .click("import")
  .wait(1800)
  .mark("finished")
  .wait(1600)
  .build(1400);

function zoteroRows(f: Frame) {
  const { p, c, t } = f;
  const ready = zoteroItems.filter((item) => !item.missing).length;
  p.text(
    `共 ${zoteroItems.length} 条记录 · ${ready} 条可导入`,
    Z.x + 20,
    Z.y + 96,
    {
      size: 10.5,
      color: c.mutedForeground,
    },
  );
  button(f, selectAll, "全选可导入", "ghost", { size: 10.5 });
  const checked = f.after("selectAll");
  zoteroItems.forEach((item, i) => {
    const y = Z.y + 114 + i * 44;
    const r = { x: Z.x + 18, y, w: Z.w - 36, h: 40 };
    p.box(r, { stroke: c.border, radius: 8 });
    checkbox(f, r.x + 16, y + 20, checked && !item.missing, item.missing);
    p.text(item.title, r.x + 32, y + 14, {
      size: 11.5,
      weight: 500,
      max: r.w - 120,
    });
    p.text(item.meta, r.x + 32, y + 29, {
      size: 10,
      color: c.mutedForeground,
    });
    const right = r.x + r.w - 12;
    if (item.missing) {
      p.text("无 PDF", right, y + 20, {
        size: 10.5,
        align: "right",
        color: c.mutedForeground,
      });
      return;
    }
    const since = f.after("import") ? f.since("import") - 300 - i * 450 : -1;
    if (since >= 450) {
      p.checkCircle(right - 48, y + 20, 11, c.success);
      p.text("已导入", right, y + 20, { size: 10.5, align: "right" });
    } else if (since >= 0) {
      p.spinner(right - 48, y + 20, 4.5, t, c.mutedForeground);
      p.text("导入中", right, y + 20, {
        size: 10.5,
        align: "right",
        color: c.mutedForeground,
      });
    } else
      p.text("可导入", right, y + 20, {
        size: 10.5,
        align: "right",
        color: c.mutedForeground,
      });
  });
  button(f, { x: Z.x + 18, y: importSelected.y, w: 84, h: 28 }, "导出报告");
  button(f, { x: Z.x + 110, y: importSelected.y, w: 84, h: 28 }, "重新扫描");
  button(
    f,
    importSelected,
    f.after("finished") ? "完成" : `导入选中 ${checked ? ready : 0} 条`,
    "primary",
  );
}

const zotero = scene({
  script: zoteroScript,
  still: "finished",
  draw(f) {
    const { p, c } = f;
    library(f);
    const choosing = f.after("open") && !f.after("zotero", 200);
    if (choosing)
      importDialog(f, "", {
        appear: f.after("zotero")
          ? 1 - f.progress("zotero", 200)
          : f.progress("open", 220),
      });
    dialog(f, Z, f.progress("zotero", 220, 120), () => {
      p.text("从 Zotero 导入", Z.x + 20, Z.y + 25, { size: 14, weight: 600 });
      paragraph(
        f,
        "复制本机 PDF、论文信息、分类、标签、笔记和可转换的批注。Zotero 原数据保持不变。",
        Z.x + 20,
        Z.y + 50,
        Z.w - 40,
        { size: 10.5, leading: 16, color: c.mutedForeground },
      );
      if (f.after("scanned")) {
        p.alpha(f.progress("scanned", 250), () => zoteroRows(f));
        return;
      }
      p.text("Zotero 资料目录", Z.x + 20, Z.y + 102, {
        size: 11.5,
        weight: 500,
      });
      input(
        f,
        { x: Z.x + 18, y: Z.y + 114, w: Z.w - 36 - 84, h: 28 },
        "~/Zotero",
      );
      button(
        f,
        { x: Z.x + Z.w - 18 - 76, y: Z.y + 114, w: 76, h: 28 },
        "选择…",
      );
      p.text(
        "先下载所需附件，再完全退出 Zotero 后扫描。",
        Z.x + 20,
        Z.y + 160,
        {
          size: 10,
          color: c.mutedForeground,
        },
      );
      if (f.after("scan")) {
        p.box(scanButton, { fill: c.primary, radius: 6 });
        p.alpha(0.7, () => {
          p.spinner(
            scanButton.x + 22,
            scanButton.y + 14,
            4,
            f.t,
            c.primaryForeground,
          );
          p.text("扫描中", scanButton.x + 34, scanButton.y + 14, {
            size: 11,
            weight: 500,
            color: c.primaryForeground,
          });
        });
      } else button(f, scanButton, "扫描资料库", "primary");
    });
  },
});

// Reader Connector in Chrome.
const browserBar = 40;
const extensionButton = { x: 594, y: 17, w: 24, h: 24 };
const P: Rect = { x: 392, y: 46, w: 232, h: 306 };
const folderInput = { x: P.x + 14, y: P.y + 136, w: P.w - 28, h: 26 };
const tagInput = { x: P.x + 14, y: P.y + 190, w: P.w - 28, h: 26 };
const collectButton = { x: P.x + 14, y: P.y + P.h - 44, w: P.w - 28, h: 30 };

const connectorScript = script({ x: 300, y: 300 })
  .wait(400)
  .move(extensionButton, 800)
  .click("open")
  .wait(500)
  .move(folderInput, 600)
  .click("folderFocus")
  .type("folder", "语言模型")
  .wait(300)
  .move(collectButton, 600)
  .click("save")
  .wait(1300)
  .mark("saved")
  .wait(2200)
  .build(1400);

const connector = scene({
  script: connectorScript,
  draw(f) {
    const { p, c } = f;
    const browser = { x: 8, y: 8, w: 624, h: 384 };
    p.box(browser, { fill: c.background, radius: 10, shadow: 14 });
    p.box({ ...browser, h: browserBar }, { fill: c.muted, radius: 10 });
    p.box(
      { x: browser.x, y: browser.y + browserBar - 10, w: browser.w, h: 10 },
      { fill: c.muted, radius: 0 },
    );
    ["#ff5f57", "#febc2e", "#28c840"].forEach((color, i) =>
      p.circle(24 + i * 14, 29, 4.5, color),
    );
    glyphs.back(f, 84, 29, c.mutedForeground);
    p.box(
      { x: 104, y: 18, w: 470, h: 22 },
      { fill: c.background, stroke: c.border, radius: 11 },
    );
    p.text("arxiv.org/abs/1706.03762", 118, 29, {
      size: 11,
      color: c.mutedForeground,
    });
    button(f, extensionButton, "", "ghost", {
      icon: (g, x, y) => providerMark(g, x - 9, y - 9, "R", "#2b2b2b"),
    });
    // The paper page.
    const left = 40;
    p.text("Computer Science > Computation and Language", left, 72, {
      size: 10,
      color: c.mutedForeground,
    });
    p.text("Attention Is All You Need", left, 102, { size: 19, weight: 600 });
    p.text(
      "Ashish Vaswani, Noam Shazeer, Niki Parmar, Jakob Uszkoreit, …",
      left,
      128,
      {
        size: 11,
        color: c.mutedForeground,
        max: 340,
      },
    );
    p.text("Abstract", left, 162, { size: 12.5, weight: 600 });
    paragraph(f, source, left, 186, 330, { size: 10.5, leading: 18 });
    button(f, { x: left, y: 330, w: 84, h: 26 }, "View PDF", "outline");
    if (!f.after("open")) return;
    p.alpha(f.progress("open", 180), () => {
      p.box(P, { fill: c.popover, radius: 10, shadow: 18, stroke: c.border });
      p.text("Reader Connector", P.x + 14, P.y + 24, { size: 13, weight: 600 });
      p.text("保存当前页面的 PDF 论文。", P.x + 14, P.y + 46, {
        size: 10.5,
        color: c.mutedForeground,
      });
      const item = { x: P.x + 14, y: P.y + 60, w: P.w - 28, h: 46 };
      p.box(item, { stroke: c.border, radius: 8 });
      checkbox(f, item.x + 16, item.y + 23, true);
      p.text("Attention Is All You Need", item.x + 32, item.y + 16, {
        size: 11,
        weight: 600,
        max: item.w - 42,
      });
      p.text("已发现 PDF", item.x + 32, item.y + 32, {
        size: 9.5,
        color: c.mutedForeground,
      });
      p.text("分类", P.x + 14, folderInput.y - 10, { size: 10.5, weight: 500 });
      input(f, folderInput, f.typed("语言模型", "folder"), {
        placeholder: "可选",
        focus: f.between("folderFocus", "save"),
      });
      p.text("标签", P.x + 14, tagInput.y - 10, { size: 10.5, weight: 500 });
      input(f, tagInput, "", { placeholder: "用逗号分隔，可选" });
      if (f.after("saved"))
        p.alpha(f.progress("saved", 250), () => {
          p.checkCircle(P.x + 20, P.y + 236, 11, c.success);
          p.text("已收录 1 篇，失败 0 篇", P.x + 32, P.y + 236, {
            size: 10.5,
            weight: 500,
          });
        });
      else
        paragraph(
          f,
          "首次收录时，Chrome 会请求网站访问权限。",
          P.x + 14,
          P.y + 236,
          P.w - 28,
          { size: 9.5, leading: 14, color: c.mutedForeground },
        );
      button(
        f,
        collectButton,
        f.between("save", "saved") ? "正在处理…" : "收录 1 篇到 Reader",
        "primary",
      );
    });
  },
});

// Journal ranks.
type Tone = "high" | "mid";
const toneColors: Record<Tone, { tint: string; light: string; dark: string }> =
  {
    high: { tint: "rgb(178 84 216 / 24%)", light: "#762994", dark: "#e6afea" },
    mid: { tint: "rgb(141 106 210 / 22%)", light: "#60419c", dark: "#c5b3ed" },
  };
const rankedPapers: { title: string; meta: string; ranks: [string, Tone][] }[] =
  [
    {
      title: "Attention Is All You Need",
      meta: "Vaswani et al. · NeurIPS 2017",
      ranks: [["CCF A", "high"]],
    },
    {
      title: "Highly accurate protein structure prediction with AlphaFold",
      meta: "Jumper et al. · Nature 2021",
      ranks: [
        ["SCI Q1", "high"],
        ["中科院 1区", "high"],
        ["IF 50.5", "high"],
      ],
    },
    {
      title: "Deep Residual Learning for Image Recognition",
      meta: "He et al. · CVPR 2016",
      ranks: [["CCF A", "high"]],
    },
    {
      title: "BERT: Pre-training of Deep Bidirectional Transformers",
      meta: "Devlin et al. · NAACL 2019",
      ranks: [["CCF B", "mid"]],
    },
    {
      title: "Graph Neural Networks: A Review of Methods and Applications",
      meta: "Zhou et al. · AI Open 2020",
      ranks: [
        ["SCI Q2", "mid"],
        ["中科院 2区", "mid"],
      ],
    },
  ];

function rankBadge(f: Frame, x: number, y: number, label: string, tone: Tone) {
  const { p, c } = f;
  const w = p.measure(label, 9.5, 600) + 12;
  const colors = toneColors[tone];
  p.box({ x, y: y - 8, w, h: 16 }, { fill: colors.tint, radius: 5 });
  p.text(label, x + 6, y, {
    size: 9.5,
    weight: 600,
    color: c.dark ? colors.dark : colors.light,
  });
  return w;
}

const rankInput = { x: D.x + 42, y: D.y + 166, w: D.w - 134, h: 28 };
const rankSave = { x: D.x + D.w - 80, y: D.y + 166, w: 58, h: 28 };
const settingsClose = { x: D.x + D.w - 30, y: D.y + 13, w: 20, h: 20 };

const ranksScript = script({ x: 560, y: 380 })
  .wait(400)
  .move(rankInput, 800)
  .click("focus")
  .type("key", "a1b2c3d4e5f6")
  .wait(250)
  .move(rankSave, 500)
  .click("save")
  .wait(700)
  .move(settingsClose, 600)
  .click("close")
  .wait(300)
  .mark("badges")
  .wait(2800)
  .build(1400);

const ranks = scene({
  script: ranksScript,
  draw(f) {
    const { p, c } = f;
    sidebar(f);
    card(f);
    libraryHeader(f);
    rankedPapers.forEach((paper, i) => {
      const y = main.y + 60 + i * 46;
      const r = { x: main.x + 16, y, w: main.w - 32, h: 40 };
      paperRow(f, y, "", paper.meta);
      const badges = paper.ranks.reduce(
        (sum, [label]) => sum + p.measure(label, 9.5, 600) + 16,
        0,
      );
      const titleMax = r.w - 60 - badges;
      p.text(paper.title, r.x + 38, y + 14, {
        size: 11.5,
        weight: 500,
        max: titleMax,
      });
      if (!f.after("badges")) return;
      let x =
        r.x + 38 + Math.min(p.measure(paper.title, 11.5, 500), titleMax) + 8;
      p.alpha(f.progress("badges", 250, i * 120), () => {
        for (const [label, tone] of paper.ranks)
          x += rankBadge(f, x, y + 14, label, tone) + 4;
      });
    });
    const appear = f.after("close") ? 1 - f.progress("close", 200) : 1;
    dialog(f, D, appear, () => {
      settingsFrame(f);
      tabs(f, settingsTabs, ["Agent", "显示", "阅读", "论文库"], 3);
      p.text("期刊指标", D.x + 22, D.y + 99, { size: 12, weight: 600 });
      checkbox(f, D.x + 28, D.y + 126, true);
      p.text("在论文库显示 easyScholar 期刊指标", D.x + 42, D.y + 126, {
        size: 11.5,
      });
      p.text(
        "默认开启；配置 SecretKey 后按论文出处查询。",
        D.x + 42,
        D.y + 145,
        {
          size: 10.5,
          color: c.mutedForeground,
        },
      );
      const saved = f.after("save", 200);
      input(f, rankInput, saved ? "" : f.typed("a1b2c3d4e5f6", "key"), {
        placeholder: saved
          ? "已保存 SecretKey；输入新密钥可替换"
          : "输入 easyScholar SecretKey",
        focus: f.between("focus", "save"),
        secret: true,
      });
      button(f, rankSave, "保存");
      p.text("指标筛选", D.x + 42, D.y + 222, {
        size: 10.5,
        color: c.mutedForeground,
      });
      select(
        f,
        { x: D.x + 100, y: D.y + 210, w: 170, h: 24 },
        "只显示选中的指标",
      );
      ["CCF", "SCI 分区", "中科院分区", "影响因子"].forEach((label, i) => {
        const x = D.x + 42 + i * 96;
        checkbox(f, x + 6, D.y + 262, true);
        p.text(label, x + 18, D.y + 262, { size: 10.5 });
      });
    });
  },
});

// Hover over a highlight to read its note.
const noteText =
  "A neural network learns by adjusting its weights to reduce a cost function. Gradient descent takes small steps downhill on that cost, and backpropagation computes every partial derivative it needs in a single backward pass through the network. Without backpropagation, training deep networks would be far too slow to be practical. The same idea, applied with care, also explains why some networks learn slowly: when the gradients become very small in early layers, those layers barely change at all.";
const notesX = 44;
const notesWidth = 320;
const noteLine = (i: number) => content.y + 62 + i * 22;
const highlights = [
  {
    line: 1,
    tint: "rgb(250 204 21 / 34%)",
    note: "反向传播一次反向遍历就得到全部偏导，代价与一次前向计算相当。",
  },
  {
    line: 5,
    tint: "rgb(74 222 128 / 30%)",
    note: "这就是梯度消失：靠近输入的层几乎学不动，第 5 章会给出原因。",
  },
];

const hoverScript = script({ x: 520, y: 360 })
  .wait(500)
  .move({ x: notesX + 120, y: noteLine(1) }, 800)
  .mark("h0")
  .wait(1900)
  .move({ x: notesX + 160, y: noteLine(3) + 4 }, 500)
  .mark("leave")
  .wait(400)
  .move({ x: notesX + 110, y: noteLine(5) }, 500)
  .mark("h1")
  .wait(2100)
  .build(1200);

const hoverNote = scene({
  script: hoverScript,
  still: "h1",
  draw(f) {
    const { p, c } = f;
    readerTop(f, "Neural Networks and Deep Learning");
    card(f, content);
    p.text("How backpropagation works", notesX, content.y + 32, {
      size: 13,
      weight: 600,
    });
    const lines = wrap(f, noteText, notesWidth, 12);
    highlights.forEach((h, i) => {
      const text = lines[h.line];
      if (!text) return;
      const r = {
        x: notesX - 2,
        y: noteLine(h.line) - 10,
        w: p.measure(text, 12) + 4,
        h: 20,
      };
      p.box(r, { fill: h.tint, radius: 3 });
      if (!f.hover(r)) return;
      const mark = `h${i}`;
      const width = 210;
      const body = wrap(f, h.note, width - 24, 11).length * 18;
      const popover = {
        x: notesX + notesWidth + 22,
        y: r.y - 6,
        w: width,
        h: body + 38,
      };
      p.alpha(f.after(mark) ? f.progress(mark, 180, 120) : 1, () => {
        p.box(popover, {
          fill: c.popover,
          radius: 10,
          shadow: 16,
          stroke: c.border,
        });
        paragraph(f, h.note, popover.x + 12, popover.y + 18, width - 24, {
          size: 11,
          leading: 18,
        });
        glyphs.edit(
          f,
          popover.x + popover.w - 18,
          popover.y + popover.h - 15,
          c.mutedForeground,
        );
      });
    });
    lines.forEach((line, i) => p.text(line, notesX, noteLine(i), { size: 12 }));
  },
});

// Export an annotated copy of a PDF.
const contextPoint = { x: 330, y: main.y + 80 };
const contextItems = [
  "复制阅读链接",
  "打开论文主页",
  "在访达中显示",
  "导出带批注的 PDF",
  "移到图书库",
];

const exportScript = script({ x: 520, y: 340 })
  .wait(400)
  .move(contextPoint, 800)
  .click("menu")
  .wait(500)
  .move(menuRow(contextPoint.x, contextPoint.y, 176, 3), 600)
  .wait(300)
  .click("export")
  .wait(1300)
  .mark("exported")
  .wait(400)
  .mark("preview")
  .wait(2800)
  .build(1400);

function annotatedPage(f: Frame, r: Rect) {
  const { p, c } = f;
  p.box(r, { fill: "#ffffff", radius: 3, shadow: 14 });
  const x = r.x + 14;
  const w = r.w - 28;
  const rows = [0.95, 1, 0.9, 0.97, 0.6, 1, 0.92, 0.98, 0.7, 1, 0.88, 0.5];
  rows.forEach((v, i) => {
    const y = r.y + 18 + i * 13;
    if (i === 1 || i === 2)
      p.box(
        { x: x - 2, y: y - 4, w: w * v + 4, h: 12 },
        {
          fill: "rgb(250 204 21 / 45%)",
          radius: 2,
        },
      );
    if (i === 6)
      p.box(
        { x: x - 2, y: y - 4, w: w * v + 4, h: 12 },
        {
          fill: "rgb(74 222 128 / 40%)",
          radius: 2,
        },
      );
    p.box({ x, y, w: w * v, h: 4 }, { fill: "#d4d4d8", radius: 2 });
    if (i === 9) p.line(x, y + 7, x + w * v, y + 7, "#3b82f6", 1.4);
  });
  // A note icon in the margin, as PDF readers show it.
  p.box(
    { x: r.x + r.w - 14, y: r.y + 92, w: 10, h: 10 },
    { fill: "#facc15", radius: 2 },
  );
  p.text("Scaling Laws…-批注.pdf", r.x + r.w / 2, r.y + r.h + 14, {
    size: 10,
    align: "center",
    color: c.foreground,
  });
}

/** A Downloads window showing the exported copy. */
function downloads(f: Frame, r: Rect) {
  const { p, c } = f;
  p.box(r, { fill: c.popover, radius: 10, shadow: 18, stroke: c.border });
  ["#ff5f57", "#febc2e", "#28c840"].forEach((color, i) =>
    p.circle(r.x + 13 + i * 12, r.y + 13, 3.5, color),
  );
  p.text("下载", r.x + r.w / 2, r.y + 13, {
    size: 10.5,
    weight: 600,
    align: "center",
  });
  p.line(r.x, r.y + 26, r.x + r.w, r.y + 26, c.border);
  annotatedPage(f, { x: r.x + 25, y: r.y + 40, w: r.w - 50, h: 190 });
}

const exportPdf = scene({
  script: exportScript,
  draw(f) {
    const menuOpen = f.between("menu", "export");
    library(f, paperTitles.slice(0, 4), 0, menuOpen ? 0 : undefined);
    if (menuOpen)
      menu(f, contextPoint.x, contextPoint.y, 176, contextItems, {
        appear: f.progress("menu", 150),
      });
    if (f.between("export", "exported"))
      toast(
        f,
        "正在导出带批注的 PDF…",
        f.progress("export", 200, 100),
        "loading",
      );
    if (f.after("exported"))
      toast(f, "已导出 12 条批注", 1 - f.progress("exported", 300, 2600));
    if (f.after("preview")) {
      const k = f.progress("preview", 400);
      f.p.alpha(k, () =>
        downloads(f, { x: 420, y: 64 + (1 - k) * 12, w: 200, h: 262 }),
      );
    }
  },
});

// Reading appearance: themes recolor the PDF, sliders scale it.
const appearanceButton = { x: 566, y: 11, w: 24, h: 22 };
const A: Rect = { x: 354, y: 40, w: 270, h: 214 };
const themeTabs = { x: A.x + 14, y: A.y + 36, w: A.w - 28, h: 26 };
const sliderX = A.x + 16;
const sliderW = A.w - 32;
const zoomY = A.y + 146;
const zoomThumb = { x: sliderX + sliderW * 0.4, y: zoomY };
const inks: Ink[] = [
  lightInk,
  { paper: "#f4ecd8", text: "#5b4636", bar: "#d9c9a8" },
  { paper: "#2f2c2f", text: "#dcd7d2", bar: "#5a555a" },
  { paper: "#000000", text: "#ffffff", bar: "#52525b" },
];
const themePane: Rect = { x: content.x, y: content.y, w: 370, h: content.h };

const appearanceScript = script({ x: 300, y: 300 })
  .wait(400)
  .move(appearanceButton, 800)
  .click("open")
  .wait(400)
  .move(tabRects(themeTabs, 5)[2], 600)
  .click("graphite")
  .wait(1600)
  .move(tabRects(themeTabs, 5)[3], 500)
  .click("black")
  .wait(1500)
  .move(zoomThumb, 600)
  .mark("grab")
  .move({ x: zoomThumb.x + 40, y: zoomY }, 900)
  .mark("drop")
  .wait(1600)
  .build(1400);

const appearance = scene({
  script: appearanceScript,
  draw(f) {
    const { p, c } = f;
    readerTop(f);
    button(f, appearanceButton, "", "ghost", {
      icon: glyphs.type,
      active: f.after("open"),
    });
    card(f, content);
    const theme = f.after("black") ? 3 : f.after("graphite") ? 2 : 0;
    const previous = theme === 3 ? 2 : 0;
    const change = theme === 3 ? "black" : "graphite";
    const zoom =
      1 +
      0.25 *
        (f.after("drop")
          ? 1
          : f.after("grab")
            ? Math.max(0, Math.min(1, (f.cursor.x - zoomThumb.x) / 40))
            : 0);
    p.ctx.save();
    p.ctx.beginPath();
    p.ctx.rect(themePane.x, themePane.y, themePane.w, themePane.h);
    p.ctx.clip();
    p.ctx.translate(themePane.x + 56, themePane.y + 14);
    p.ctx.scale(zoom, zoom);
    const sheet = { x: 0, y: 0, w: 260, h: 320 };
    if (theme) {
      pdfPage(f, sheet, inks[previous]);
      p.alpha(f.progress(change, 350), () => pdfPage(f, sheet, inks[theme]));
    } else pdfPage(f, sheet, inks[0]);
    p.ctx.restore();
    if (!f.after("open")) return;
    p.alpha(f.progress("open", 180), () => {
      p.box(A, { fill: c.popover, radius: 10, shadow: 18, stroke: c.border });
      p.text("阅读外观", A.x + 16, A.y + 20, { size: 12.5, weight: 600 });
      tabs(f, themeTabs, ["浅色", "纸张", "石墨", "纯黑", "跟随系统"], theme);
      const rows: [string, string, number, number][] = [
        ["Agent 字号", "14", A.y + 96, 0.5],
        [
          "原文缩放",
          `${Math.round(zoom * 100)}%`,
          zoomY,
          0.4 + (zoom - 1) * 0.64,
        ],
        ["译文字号", "16", A.y + 196, 0.55],
      ];
      for (const [label, value, y, v] of rows) {
        p.text(label, sliderX, y - 16, { size: 11 });
        p.text(value, sliderX + sliderW, y - 16, {
          size: 11,
          align: "right",
          color: c.mutedForeground,
        });
        slider(f, sliderX, y, sliderW, v);
      }
    });
  },
});

// The reader command line.
const cliPanel: Rect = { x: 22, y: 66, w: 262, h: 212 };
const installButton = {
  x: cliPanel.x + 16,
  y: cliPanel.y + 128,
  w: 140,
  h: 28,
};
const cliTerm: Rect = { x: 300, y: 46, w: 320, h: 316 };
const searchCommand = "reader search attention dropout";
const readCommand = "reader read 1a2b3c4d --pages 8";

const cliScript = script({ x: 200, y: 340 })
  .wait(400)
  .move(installButton, 700)
  .click("install")
  .wait(900)
  .mark("installed")
  .wait(700)
  .move({ x: 470, y: 200 }, 700)
  .click("focus")
  .wait(200)
  .type("search", searchCommand)
  .wait(300)
  .mark("results")
  .wait(1400)
  .type("read", readCommand)
  .wait(300)
  .mark("text")
  .wait(2400)
  .build(1400);

function cliLines(f: Frame) {
  const gray = "#a1a1aa";
  const lines: TerminalLine[] = [
    { text: `~ % ${f.typed(searchCommand, "search")}` },
  ];
  if (!f.after("results")) return lines;
  lines.push(
    { text: "1a2b3c4d  Attention Is All You Need  第 8 页" },
    { text: "    …we apply dropout to the output of each…", color: gray },
    { text: "共 1 条", color: gray },
    { text: `~ % ${f.typed(readCommand, "read")}` },
  );
  if (!f.after("text")) return lines;
  lines.push(
    { text: "# Attention Is All You Need" },
    { text: "## 第 8 页", color: gray },
    { text: "Residual Dropout We apply dropout to" },
    { text: "the output of each sub-layer, before…" },
    { text: "~ % " },
  );
  return lines;
}

const cli = scene({
  script: cliScript,
  draw(f) {
    const { p, c } = f;
    chrome(f);
    p.text("Reader 设置 · Agent", cliPanel.x, 36, {
      size: 11,
      weight: 600,
      color: c.mutedForeground,
    });
    p.box(cliPanel, { fill: c.popover, radius: 12, shadow: 14 });
    p.text("命令行工具", cliPanel.x + 16, cliPanel.y + 24, {
      size: 12,
      weight: 600,
    });
    paragraph(
      f,
      "在终端运行 reader，让 Claude Code、Codex 等工具检索、阅读和导入书库中的文档。使用时 Reader 需要保持打开。",
      cliPanel.x + 16,
      cliPanel.y + 50,
      cliPanel.w - 32,
      { size: 10.5, leading: 17, color: c.mutedForeground },
    );
    const installed = f.after("installed");
    if (f.between("install", "installed")) {
      p.box(installButton, { fill: c.background, stroke: c.border, radius: 6 });
      p.spinner(
        installButton.x + 18,
        installButton.y + 14,
        4.5,
        f.t,
        c.mutedForeground,
      );
      p.text("安装 reader 命令", installButton.x + 30, installButton.y + 14, {
        size: 11.5,
        weight: 500,
      });
    } else
      button(
        f,
        installButton,
        installed ? "卸载 reader 命令" : "安装 reader 命令",
        "outline",
        { icon: glyphs.terminal },
      );
    p.text(
      installed
        ? "已安装：/usr/local/bin/reader"
        : "将安装到 /usr/local/bin，可能需要输入密码",
      cliPanel.x + 16,
      cliPanel.y + 178,
      { size: 10, color: c.mutedForeground, max: cliPanel.w - 32 },
    );
    terminal(f, cliTerm, cliLines(f), f.after("focus"));
  },
});

export const scenes = {
  detect,
  login,
  api: apiScene,
  models,
  link,
  pdf,
  modes,
  assistant,
  research,
  pages,
  overview,
  zotero,
  connector,
  ranks,
  hoverNote,
  exportPdf,
  appearance,
  cli,
} satisfies Record<string, Scene>;
export type SceneId = keyof typeof scenes;
