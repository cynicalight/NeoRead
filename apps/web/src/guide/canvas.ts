// A small canvas engine for guide demonstrations. A scene is a cursor script
// (moves, clicks, typing, named marks) plus a draw function that paints a
// simplified NeoRead interface for any moment of that script.

export interface Point {
  x: number;
  y: number;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export const center = (r: Rect): Point => ({
  x: r.x + r.w / 2,
  y: r.y + r.h / 2,
});
export const inside = (p: Point, r: Rect) =>
  p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

export const ease = (v: number) => {
  const x = Math.min(1, Math.max(0, v));
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
};

/** Milliseconds per typed character. */
export const typingSpeed = 55;
const clickDuration = 260;

export interface Script {
  /** One loop, including the final hold. */
  duration: number;
  /** When the last scripted action ends. */
  end: number;
  marks: Record<string, number>;
  clicks: number[];
  keys: { at: number; x: number; y: number }[];
}

export class ScriptBuilder {
  now = 0;
  marks: Record<string, number> = {};
  clicks: number[] = [];
  keys: { at: number; x: number; y: number }[];
  constructor(start: Point) {
    this.keys = [{ at: 0, ...start }];
  }
  private get last() {
    return this.keys[this.keys.length - 1];
  }
  wait(ms: number) {
    this.now += ms;
    return this;
  }
  mark(name: string) {
    this.marks[name] = this.now;
    return this;
  }
  /** Moves the cursor to a point or to the center of a rectangle. */
  move(to: Point | Rect, ms = 650) {
    const target = "w" in to ? center(to) : to;
    this.keys.push({ at: this.now, x: this.last.x, y: this.last.y });
    this.now += ms;
    this.keys.push({ at: this.now, ...target });
    return this;
  }
  /** Clicks where the cursor is; the mark is set at the moment of the press. */
  click(name?: string) {
    this.clicks.push(this.now);
    if (name) this.marks[name] = this.now;
    this.now += clickDuration;
    return this;
  }
  /** Types text; draw it with `frame.typed(text, name)`. */
  type(name: string, text: string) {
    this.marks[name] = this.now;
    this.now += text.length * typingSpeed;
    return this;
  }
  build(hold = 1800): Script {
    return {
      duration: this.now + hold,
      end: this.now,
      marks: this.marks,
      clicks: this.clicks,
      keys: [...this.keys, { ...this.last, at: this.now + hold }],
    };
  }
}
export const script = (start: Point) => new ScriptBuilder(start);

export function cursorAt(s: Script, t: number): Point {
  const keys = s.keys;
  if (t <= keys[0].at) return keys[0];
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1];
    const b = keys[i];
    if (t <= b.at) {
      const k = b.at === a.at ? 1 : ease((t - a.at) / (b.at - a.at));
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
    }
  }
  return keys[keys.length - 1];
}

export interface Palette {
  background: string;
  foreground: string;
  card: string;
  popover: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  border: string;
  input: string;
  ring: string;
  /** The window surface behind the sidebar. */
  surface: string;
  success: string;
  warning: string;
  dark: boolean;
}

const fallback: Palette = {
  background: "#ffffff",
  foreground: "#1f1f1f",
  card: "#ffffff",
  popover: "#ffffff",
  primary: "#2b2b2b",
  primaryForeground: "#fafafa",
  secondary: "#f3f3f3",
  muted: "#f3f3f3",
  mutedForeground: "#737373",
  accent: "#efefef",
  border: "#e7e7e7",
  input: "#dedede",
  ring: "#a3a3a3",
  surface: "#f7f7f7",
  success: "#16a34a",
  warning: "#d97706",
  dark: false,
};

/** Resolves the theme tokens to colors a canvas accepts. */
export function readPalette(root: HTMLElement = document.documentElement) {
  const probe = document.createElement("span");
  probe.style.display = "none";
  root.appendChild(probe);
  const resolve = (value: string, backup: string) => {
    probe.style.color = "";
    probe.style.color = value;
    return getComputedStyle(probe).color || backup;
  };
  const token = (name: string, key: keyof Palette) =>
    resolve(`var(--${name})`, fallback[key] as string);
  const dark = root.classList.contains("dark");
  const palette: Palette = {
    background: token("background", "background"),
    foreground: token("foreground", "foreground"),
    card: token("card", "card"),
    popover: token("popover", "popover"),
    primary: token("primary", "primary"),
    primaryForeground: token("primary-foreground", "primaryForeground"),
    secondary: token("secondary", "secondary"),
    muted: token("muted", "muted"),
    mutedForeground: token("muted-foreground", "mutedForeground"),
    accent: token("accent", "accent"),
    border: token("border", "border"),
    input: token("input", "input"),
    ring: token("ring", "ring"),
    surface: resolve(
      "color-mix(in oklch, var(--muted) 60%, var(--background))",
      fallback.surface,
    ),
    success: dark ? "#4ade80" : "#16a34a",
    warning: dark ? "#fbbf24" : "#d97706",
    dark,
  };
  probe.remove();
  return palette;
}

export interface TextStyle {
  size?: number;
  weight?: number;
  color?: string;
  align?: CanvasTextAlign;
  /** Truncates with an ellipsis beyond this width. */
  max?: number;
  mono?: boolean;
}

const monoFamily = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

export class Painter {
  constructor(
    readonly ctx: CanvasRenderingContext2D,
    readonly c: Palette,
    readonly family: string,
  ) {}
  font(size = 12, weight = 400, mono = false) {
    return `${weight} ${size}px ${mono ? monoFamily : this.family}`;
  }
  path(r: Rect, radius: number) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.roundRect(r.x, r.y, r.w, r.h, Math.min(radius, r.h / 2, r.w / 2));
  }
  box(
    r: Rect,
    o: {
      fill?: string;
      stroke?: string;
      radius?: number;
      shadow?: number;
      line?: number;
    },
  ) {
    const ctx = this.ctx;
    ctx.save();
    this.path(r, o.radius ?? 6);
    if (o.shadow) {
      ctx.shadowColor = this.c.dark ? "rgb(0 0 0 / 45%)" : "rgb(0 0 0 / 12%)";
      ctx.shadowBlur = o.shadow;
      ctx.shadowOffsetY = o.shadow / 3;
    }
    if (o.fill) {
      ctx.fillStyle = o.fill;
      ctx.fill();
    }
    ctx.shadowColor = "transparent";
    if (o.stroke) {
      ctx.lineWidth = o.line ?? 1;
      ctx.strokeStyle = o.stroke;
      ctx.stroke();
    }
    ctx.restore();
  }
  text(value: string, x: number, y: number, o: TextStyle = {}) {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = this.font(o.size, o.weight, o.mono);
    ctx.fillStyle = o.color ?? this.c.foreground;
    ctx.textAlign = o.align ?? "left";
    ctx.textBaseline = "middle";
    let shown = value;
    if (o.max && ctx.measureText(shown).width > o.max) {
      while (shown && ctx.measureText(`${shown}…`).width > o.max)
        shown = shown.slice(0, -1);
      shown = `${shown}…`;
    }
    ctx.fillText(shown, x, y);
    ctx.restore();
  }
  measure(value: string, size = 12, weight = 400, mono = false) {
    this.ctx.save();
    this.ctx.font = this.font(size, weight, mono);
    const width = this.ctx.measureText(value).width;
    this.ctx.restore();
    return width;
  }
  line(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    color: string,
    width = 1,
  ) {
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.stroke();
    ctx.restore();
  }
  /** Placeholder lines of text: widths are fractions of the area. */
  bars(
    r: Rect,
    widths: number[],
    o: { color?: string; gap?: number; height?: number } = {},
  ) {
    const height = o.height ?? 5;
    const gap = o.gap ?? 11;
    widths.forEach((w, i) =>
      this.box(
        { x: r.x, y: r.y + i * gap, w: r.w * w, h: height },
        { fill: o.color ?? this.c.border, radius: height / 2 },
      ),
    );
  }
  alpha(value: number, draw: () => void) {
    if (value <= 0) return;
    this.ctx.save();
    this.ctx.globalAlpha *= Math.min(1, value);
    draw();
    this.ctx.restore();
  }
  circle(x: number, y: number, r: number, fill?: string, stroke?: string) {
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
    ctx.restore();
  }
  check(x: number, y: number, size: number, color: string) {
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x - size * 0.45, y);
    ctx.lineTo(x - size * 0.12, y + size * 0.32);
    ctx.lineTo(x + size * 0.48, y - size * 0.34);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.restore();
  }
  checkCircle(x: number, y: number, size: number, color: string) {
    this.circle(x, y, size / 2, undefined, color);
    this.check(x, y, size * 0.55, color);
  }
  spinner(x: number, y: number, r: number, t: number, color: string) {
    const ctx = this.ctx;
    const start = (t / 140) % (Math.PI * 2);
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, start, start + Math.PI * 1.4);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.lineCap = "round";
    ctx.stroke();
    ctx.restore();
  }
  warning(x: number, y: number, size: number, color: string) {
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, y - size / 2);
    ctx.lineTo(x + size / 2, y + size / 2.4);
    ctx.lineTo(x - size / 2, y + size / 2.4);
    ctx.closePath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.restore();
    this.line(x, y - size / 6, x, y + size / 8, color, 1.4);
  }
  chevron(x: number, y: number, size: number, color: string, up = false) {
    const d = up ? -1 : 1;
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x - size / 2, y - (d * size) / 4);
    ctx.lineTo(x, y + (d * size) / 4);
    ctx.lineTo(x + size / 2, y - (d * size) / 4);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.restore();
  }
  /** A macOS-style arrow pointer. */
  pointer(p: Point, scale = 1) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.scale(scale, scale);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, 17);
    ctx.lineTo(4.2, 13);
    ctx.lineTo(7, 19.4);
    ctx.lineTo(9.8, 18.2);
    ctx.lineTo(7.1, 12);
    ctx.lineTo(12.6, 12);
    ctx.closePath();
    ctx.shadowColor = "rgb(0 0 0 / 30%)";
    ctx.shadowBlur = 3;
    ctx.shadowOffsetY = 1;
    ctx.fillStyle = "#111111";
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.3;
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.restore();
  }
}

/** Everything a scene needs to draw one moment. */
export class Frame {
  readonly cursor: Point;
  constructor(
    readonly p: Painter,
    readonly s: Script,
    readonly t: number,
  ) {
    this.cursor = cursorAt(s, t);
  }
  get c() {
    return this.p.c;
  }
  at(mark: string) {
    const value = this.s.marks[mark];
    if (value === undefined) throw new Error(`unknown guide mark: ${mark}`);
    return value;
  }
  /** Milliseconds since a mark; negative before it. */
  since(mark: string) {
    return this.t - this.at(mark);
  }
  after(mark: string, delay = 0) {
    return this.since(mark) >= delay;
  }
  between(from: string, to: string) {
    return this.after(from) && !this.after(to);
  }
  /** 0 → 1 over `ms` after a mark, eased. */
  progress(mark: string, ms = 300, delay = 0) {
    return ease((this.since(mark) - delay) / ms);
  }
  typed(text: string, mark: string) {
    const count = Math.floor(this.since(mark) / typingSpeed);
    return count <= 0 ? "" : text.slice(0, count);
  }
  hover(r: Rect) {
    return inside(this.cursor, r);
  }
  pressed(r: Rect) {
    return (
      this.hover(r) &&
      this.s.clicks.some((at) => this.t >= at && this.t - at < 160)
    );
  }
}

export interface Scene {
  /** Logical size; the canvas scales it to fit. */
  width: number;
  height: number;
  script: Script;
  draw(f: Frame): void;
  /** Mark shown when motion is reduced; the end of the script by default. */
  still?: string;
  /** Pointer size; larger pointers make the demonstrated gesture easier to follow. */
  pointerScale?: number;
}

export const sceneSize = { width: 640, height: 400 };

const fade = 320;

/** Paints one moment of a scene, with the pointer and click ripples. */
export function paint(
  scene: Scene,
  painter: Painter,
  t: number,
  motion = true,
) {
  const { ctx, c } = painter;
  const frame = new Frame(painter, scene.script, t);
  ctx.save();
  ctx.fillStyle = c.surface;
  ctx.fillRect(0, 0, scene.width, scene.height);
  scene.draw(frame);
  for (const at of scene.script.clicks) {
    const age = t - at;
    if (!motion || age < 0 || age > 450) continue;
    const k = age / 450;
    painter.alpha(1 - k, () =>
      painter.circle(
        frame.cursor.x,
        frame.cursor.y,
        6 + 14 * ease(k),
        c.dark ? "rgb(255 255 255 / 28%)" : "rgb(0 0 0 / 14%)",
      ),
    );
  }
  const pressed = scene.script.clicks.some((at) => t >= at && t - at < 140);
  painter.pointer(
    frame.cursor,
    (scene.pointerScale ?? 1) * (pressed && motion ? 0.88 : 1),
  );
  if (motion) {
    // Fade between loops instead of jumping back to the first state.
    const edge = Math.min(t, scene.script.duration - t);
    if (edge < fade) {
      ctx.globalAlpha = 1 - edge / fade;
      ctx.fillStyle = c.surface;
      ctx.fillRect(0, 0, scene.width, scene.height);
    }
  }
  ctx.restore();
  return frame;
}

/** The moment drawn when motion is reduced. */
export function stillTime(scene: Scene) {
  const { script } = scene;
  // Leave time for the last transition to settle.
  return scene.still
    ? script.marks[scene.still]
    : Math.min(script.end + 900, script.duration - fade - 1);
}
