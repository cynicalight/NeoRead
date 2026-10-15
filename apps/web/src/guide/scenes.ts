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
  checks,
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
  sparkle,
  tabRects,
  tabs,
  tooltip,
  wrap,
  type CheckState,
} from "./mock";

const scene = (s: Omit<Scene, "width" | "height">): Scene => ({
  ...sceneSize,
  ...s,
});

/** The paper library behind dialogs. */
function library(f: Frame, rows = paperTitles.slice(0, 4), shift = 0) {
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
  const lines: { text: string; color?: string }[] = [
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

const login = scene({
  script: loginScript,
  draw(f) {
    const { p, c } = f;
    chrome(f);
    p.text("终端", 22, 36, { size: 11, weight: 600, color: c.mutedForeground });
    p.box(term, { fill: "#18181b", radius: 10, shadow: 14 });
    p.box(
      { x: term.x, y: term.y, w: term.w, h: 26 },
      { fill: "#27272a", radius: 10 },
    );
    p.box(
      { x: term.x, y: term.y + 16, w: term.w, h: 10 },
      { fill: "#27272a", radius: 0 },
    );
    ["#ff5f57", "#febc2e", "#28c840"].forEach((color, i) =>
      p.circle(term.x + 14 + i * 13, term.y + 13, 4, color),
    );
    p.text("zsh", term.x + term.w / 2, term.y + 13, {
      size: 10.5,
      align: "center",
      color: "#a1a1aa",
    });
    const lines = terminalLines(f);
    lines.forEach((line, i) =>
      p.text(line.text, term.x + 14, term.y + 46 + i * 20, {
        size: 11,
        mono: true,
        color: line.color ?? "#f4f4f5",
        max: term.w - 28,
      }),
    );
    const last = lines.length - 1;
    if (f.after("focus") && Math.floor(f.t / 500) % 2 === 0) {
      const x = term.x + 14 + p.measure(lines[last].text, 11, 400, true) + 2;
      p.box(
        { x, y: term.y + 39 + last * 20, w: 6, h: 14 },
        { fill: "#f4f4f5", radius: 1 },
      );
    }

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
    if (f.after("drop", 300)) {
      const appear = Math.min(
        f.progress("drop", 200, 300),
        1 - f.progress("drop", 300, 2300),
      );
      const toast = { x: 640 - 200 - 18, y: 400 - 48 - 16, w: 200, h: 44 };
      p.alpha(appear, () => {
        p.box(toast, {
          fill: c.popover,
          radius: 8,
          shadow: 14,
          stroke: c.border,
        });
        p.checkCircle(toast.x + 20, toast.y + 22, 12, c.success);
        p.text("已导入 1 个文件", toast.x + 36, toast.y + 22, {
          size: 11.5,
          weight: 500,
        });
      });
    }
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

const assistant = scene({
  script: assistantScript,
  draw(f) {
    const { p, c } = f;
    chrome(f);
    glyphs.back(f, 72, 22, c.mutedForeground);
    p.text("Attention Is All You Need", 84, 22, {
      size: 12,
      weight: 600,
      max: 220,
    });
    card(f, page);
    card(f, side);
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
    // Sidebar.
    tabs(
      f,
      { x: side.x + 10, y: side.y + 10, w: 130, h: 26 },
      ["Agent", "批注"],
      0,
    );
    if (!f.after("ask"))
      paragraph(
        f,
        "选中原文，可以翻译、解释，或引用多段文字一起讨论。",
        side.x + 16,
        side.y + 140,
        side.w - 32,
        {
          size: 10.5,
          leading: 17,
          color: c.mutedForeground,
        },
      );
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
    // Composer.
    input(f, chatInput, f.after("send") ? "" : f.typed(question, "question"), {
      placeholder: "向 AI 提问",
      focus: f.between("focus", "send"),
    });
    const ready = f.after("question") && !f.after("send");
    p.circle(
      center(sendRect).x,
      center(sendRect).y,
      11,
      ready ? c.primary : c.muted,
    );
    glyphs.send(
      f,
      center(sendRect).x,
      center(sendRect).y,
      ready ? c.primaryForeground : c.mutedForeground,
    );
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
} satisfies Record<string, Scene>;
export type SceneId = keyof typeof scenes;
