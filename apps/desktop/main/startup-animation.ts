// Startup page shown before migration, PATH probing and the Go server.
// Everything is inline: no network, preload, IPC or file reads. The markup is
// readable without JavaScript or the font; the script only adds transform and
// opacity animations through the Web Animations API.

export type StartupAssets = {
  fontDataURL: string;
  logoLightDataURL: string;
  logoDarkDataURL: string;
};

// The page's <script> must contain exactly this text: startup-window.ts
// authorizes it with a CSP SHA-256 hash.
export const startupAnimationScript = `(() => {
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const pick = (selector) => document.querySelector(selector);
  let running = [];
  let paused = [];
  const ease = "cubic-bezier(.2,.7,.2,1)";
  function start(entrance) {
    if (motion.matches || typeof document.body.animate !== "function") return;
    const mark = pick(".mark"), wipe = pick(".wipe"), track = pick(".track"), bead = pick(".bead");
    const wait = entrance ? 700 : 0;
    if (entrance) running.push(
      mark.animate([{ opacity: 0, transform: "scale(.92)" }, { opacity: 1, transform: "none" }], { duration: 480, easing: ease, fill: "backwards" }),
      wipe.animate([{ transform: "translateX(0)" }, { transform: "translateX(100%)" }], { duration: 760, delay: 140, easing: "cubic-bezier(.45,.05,.3,1)", fill: "both" }),
    );
    running.push(
      track.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 400, delay: wait, fill: "both" }),
      bead.animate([{ transform: "translateX(-100%)" }, { transform: "translateX(400%)" }], { duration: 1800, delay: wait, iterations: Infinity, easing: "cubic-bezier(.45,0,.55,1)" }),
    );
    if (document.hidden) pause();
  }
  function stop() {
    for (const animation of running) animation.cancel();
    running = [];
    paused = [];
  }
  function pause() {
    paused = running.filter((animation) => animation.playState !== "finished");
    for (const animation of paused) animation.pause();
  }
  function resume() {
    for (const animation of paused) animation.play();
    paused = [];
  }
  const onVisibility = () => (document.hidden ? pause() : resume());
  const onMotion = () => (motion.matches ? stop() : running.length || start(false));
  function onPageHide() {
    stop();
    document.removeEventListener("visibilitychange", onVisibility);
    motion.removeEventListener("change", onMotion);
    removeEventListener("pagehide", onPageHide);
  }
  document.addEventListener("visibilitychange", onVisibility);
  motion.addEventListener("change", onMotion);
  addEventListener("pagehide", onPageHide);
  start(true);
})();`;

export function createStartupHTML(assets: StartupAssets): string {
  const font = assets.fontDataURL
    ? `@font-face { font-family: "NeoRead Caveat"; src: url("${assets.fontDataURL}") format("truetype"); font-weight: 600; font-style: normal; font-display: swap }`
    : "";
  const logo = (url: string, theme: string) =>
    url ? `<img class="${theme}" src="${url}" alt="" width="52" height="52" draggable="false">` : "";
  return `<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>NeoRead</title>
<style>
${font}
:root { color-scheme: light dark; --bg: #ffffff; --ink: #1f1e1d; --muted: #8a8580; --line: rgba(31, 30, 29, .08); background: var(--bg); color: var(--ink) }
@media (prefers-color-scheme: dark) { :root { --bg: #211e21; --ink: #f7f6f2; --muted: #8f8a86; --line: rgba(247, 246, 242, .1) } }
body { margin: 0; height: 100vh; display: grid; place-content: center; justify-items: center; font: 12px/1.4 system-ui, sans-serif; -webkit-app-region: drag; user-select: none; cursor: default }
main { display: grid; justify-items: center; margin-top: -4vh }
.lockup { display: flex; align-items: center; gap: 14px }
.mark { display: block; width: 52px; height: 52px }
.mark img { display: block; width: 52px; height: 52px }
.mark .dark { display: none }
@media (prefers-color-scheme: dark) { .mark .light { display: none } .mark .dark { display: block } }
.word { position: relative; overflow: hidden; padding: 4px 6px 6px 2px; font: 600 46px/1 "NeoRead Caveat", "Segoe Print", "Bradley Hand", cursive; transform: translateY(2px) }
.wipe { position: absolute; inset: 0 0 0 -24px; background: linear-gradient(to right, transparent, var(--bg) 24px); transform: translateX(100%) }
.track { width: 64px; height: 2px; margin-top: 22px; border-radius: 1px; overflow: hidden; background: var(--line); opacity: 0 }
.bead { width: 16px; height: 2px; border-radius: 1px; background: #c2643f; transform: translateX(-100%); will-change: transform }
.caption { margin: 12px 0 0; color: var(--muted) }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap }
:root[data-startup-theme="light"] { color-scheme: light; --bg: #ffffff; --ink: #1f1e1d; --muted: #8a8580; --line: rgba(31, 30, 29, .08) }
:root[data-startup-theme="dark"] { color-scheme: dark; --bg: #211e21; --ink: #f7f6f2; --muted: #8f8a86; --line: rgba(247, 246, 242, .1) }
:root[data-startup-theme="light"] .mark .light, :root[data-startup-theme="dark"] .mark .dark { display: block }
:root[data-startup-theme="light"] .mark .dark, :root[data-startup-theme="dark"] .mark .light { display: none }
</style></head><body><main>
<div class="lockup" aria-hidden="true"><span class="mark">${logo(assets.logoLightDataURL, "light")}${logo(assets.logoDarkDataURL, "dark")}</span><span class="word">NeoRead<span class="wipe"></span></span></div>
<div class="track" aria-hidden="true"><div class="bead"></div></div>
<p class="caption" role="status"><span class="sr">正在启动 NeoRead</span><span aria-hidden="true">正在启动…</span></p>
</main><script>${startupAnimationScript}</script></body></html>`;
}
