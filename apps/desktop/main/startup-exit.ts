import type { BrowserWindow } from "electron";

type StartupSnapshot = {
  html: string;
  css: string;
  theme: string;
  background: string;
};

// These functions execute in separate renderers. Keep their runtime dependencies
// inside each function: serialization must not capture module bindings.
function captureStartup(): StartupSnapshot {
  const main = document.querySelector("main");
  const style = document.querySelector("style");
  if (!main || !style) throw new Error("Startup content unavailable");
  const clone = main.cloneNode(true) as HTMLElement;
  for (const selector of [".mark", ".wipe", ".track", ".bead"]) {
    const source = main.querySelector(selector);
    const target = clone.querySelector<HTMLElement>(selector);
    if (!source || !target) continue;
    const computed = getComputedStyle(source);
    target.style.transform = computed.transform;
    target.style.opacity = computed.opacity;
  }
  return {
    html: clone.outerHTML,
    css: style.textContent ?? "",
    theme: document.documentElement.dataset.startupTheme ?? "light",
    background: getComputedStyle(document.documentElement).backgroundColor,
  };
}

async function installStartupExit(snapshot: StartupSnapshot): Promise<void> {
  const host = window as typeof window & {
    __neoreadStartupExit?: {
      cleanup: () => void;
      run: (animate?: boolean) => Promise<void>;
    };
  };
  host.__neoreadStartupExit?.cleanup();
  const overlay = document.createElement("div");
  overlay.dataset.neoreadStartupExit = "";
  // The original loading window has already announced its status.
  overlay.setAttribute("aria-hidden", "true");
  overlay.style.cssText =
    "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:auto;overflow:hidden;isolation:isolate;";
  const shadow = overlay.attachShadow({ mode: "open" });
  const fontStyle = document.createElement("style");
  fontStyle.dataset.neoreadStartupExitFonts = "";
  const fontRules = snapshot.css.match(/@font-face\s*\{[^}]*\}/g) ?? [];
  fontStyle.textContent = fontRules.join("\n");
  const style = document.createElement("style");
  style.textContent =
    snapshot.css
      .replace(/@font-face\s*\{[^}]*\}/g, "")
      .replace(/:root\b/g, ".surface")
      .replace(/\bbody\b/g, ".surface") +
    `
    .surface { height:100%; background:transparent !important; position:absolute; inset:0; -webkit-app-region:no-drag; }
    .veil { position:absolute; left:50%; top:50%; translate:-50% -50%; border-radius:50%; }
  `;
  const veil = document.createElement("div");
  veil.className = "veil";
  veil.style.background = `radial-gradient(circle closest-side, ${snapshot.background} 72%, transparent 100%)`;
  const surface = document.createElement("div");
  surface.className = "surface";
  surface.dataset.startupTheme = snapshot.theme;
  // Only the app-owned loading page supplies this markup; never document HTML.
  surface.innerHTML = snapshot.html;
  shadow.append(style, veil, surface);
  document.head.append(fontStyle);
  document.body.append(overlay);
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const animations: Animation[] = [];
  let cleaned = false;
  let running = false;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const resize = () => {
    const size = `${Math.hypot(innerWidth, innerHeight) * 1.5}px`;
    veil.style.width = size;
    veil.style.height = size;
  };
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    window.removeEventListener("pagehide", cleanup);
    window.removeEventListener("beforeunload", cleanup);
    window.removeEventListener("resize", resize);
    document.removeEventListener("visibilitychange", onVisibility);
    motion.removeEventListener("change", onMotion);
    overlay.remove();
    fontStyle.remove();
    if (host.__neoreadStartupExit === entry) delete host.__neoreadStartupExit;
    finish();
    for (const animation of animations) animation.cancel();
  };
  const onMotion = () => {
    if (motion.matches) cleanup();
  };
  const onVisibility = () => {
    if (running && document.hidden) cleanup();
  };
  const run = (animate = true): Promise<void> => {
    if (!animate || motion.matches || document.hidden) cleanup();
    if (cleaned || running) return done;
    running = true;
    try {
      const track = (animation: Animation) => {
        animations.push(animation);
        void animation.finished.catch(cleanup);
      };
      track(
        veil.animate(
          [
            { transform: "scale(1)", opacity: 1 },
            { transform: "scale(0)", opacity: 0 },
          ],
          {
            duration: 600,
            easing: "cubic-bezier(.4,0,.2,1)",
            fill: "forwards",
          },
        ),
      );
      track(
        surface.animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: 288,
          delay: 108,
          easing: "ease-out",
          fill: "forwards",
        }),
      );
      void Promise.all(animations.map((animation) => animation.finished)).then(
        cleanup,
        cleanup,
      );
    } catch {
      cleanup();
    }
    return done;
  };
  const entry = { cleanup, run };
  host.__neoreadStartupExit = entry;
  window.addEventListener("pagehide", cleanup);
  window.addEventListener("beforeunload", cleanup);
  window.addEventListener("resize", resize);
  document.addEventListener("visibilitychange", onVisibility);
  motion.addEventListener("change", onMotion);
  resize();
  // Broken embedded assets must not strand the overlay. Navigation/replacement
  // also releases preparation even if an asset promise never settles.
  const assets = [
    ...fontRules.map(() =>
      Promise.resolve().then(() =>
        document.fonts.load('600 46px "NeoRead Caveat"'),
      ),
    ),
    ...Array.from(surface.querySelectorAll("img"), (image) =>
      Promise.resolve().then(() => image.decode()),
    ),
  ];
  await Promise.race([Promise.allSettled(assets), done]);
  if (cleaned) return;
  // Give the static overlay a paint opportunity before the native handoff.
  // Two fixed frames, not a loop; occluded renderers must not strand startup.
  let frame = 0;
  let watchdog = 0;
  try {
    await Promise.race([
      done,
      new Promise<void>((resolve) => {
        frame = requestAnimationFrame(() => {
          frame = requestAnimationFrame(() => {
            frame = 0;
            resolve();
          });
        });
      }),
      new Promise<void>((resolve) => {
        watchdog = window.setTimeout(resolve, 150);
      }),
    ]);
  } finally {
    if (frame) cancelAnimationFrame(frame);
    window.clearTimeout(watchdog);
  }
}

function finishStartupExit(animate: boolean): Promise<void> | undefined {
  return (
    window as typeof window & {
      __neoreadStartupExit?: { run: (animate: boolean) => Promise<void> };
    }
  ).__neoreadStartupExit?.run(animate);
}

/** Install above the real UI before showing it; call the result after handoff. */
export async function prepareStartupExit(
  loading: BrowserWindow,
  target: BrowserWindow,
): Promise<(animate?: boolean) => Promise<void>> {
  const snapshot: StartupSnapshot = await loading.webContents.executeJavaScript(
    `(${captureStartup.toString()})()`,
  );
  await target.webContents.executeJavaScript(
    `(${installStartupExit.toString()})(${JSON.stringify(snapshot)})`,
  );
  return async (animate = true) => {
    if (target.isDestroyed() || target.webContents.isDestroyed()) return;
    await target.webContents.executeJavaScript(
      `(${finishStartupExit.toString()})(${JSON.stringify(animate)})`,
    );
  };
}
