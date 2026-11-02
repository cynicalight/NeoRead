// @vitest-environment node
import { JSDOM } from "jsdom";
import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createStartupHTML } from "./startup-animation";
import { prepareStartupExit } from "./startup-exit";

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

let source: JSDOM;
let page: JSDOM;
let loading: BrowserWindow;
let target: BrowserWindow;
let motion: EventTarget & { matches: boolean };
let fontLoad: ReturnType<typeof vi.fn>;
let decode: ReturnType<typeof vi.fn>;
let animate: ReturnType<typeof vi.fn>;
let animations: Array<
  ReturnType<typeof deferred> & { cancel: ReturnType<typeof vi.fn<() => void>> }
>;
const current = () =>
  (
    page.window as unknown as {
      __neoreadStartupExit?: {
        cleanup: () => void;
        run: (animate?: boolean) => Promise<void>;
      };
    }
  ).__neoreadStartupExit;
const overlay = () =>
  page.window.document.querySelector<HTMLElement>(
    "[data-neoread-startup-exit]",
  );
const shadow = () => overlay()!.shadowRoot!;
const assertClean = () => {
  expect(overlay()).toBeNull();
  expect(
    page.window.document.querySelector("[data-neoread-startup-exit-fonts]"),
  ).toBeNull();
  expect(current()).toBeUndefined();
  expect(page.window.document.querySelector("#real-ui")?.textContent).toBe(
    "Real reader",
  );
};

beforeEach(() => {
  source = new JSDOM(
    createStartupHTML({
      fontDataURL: "data:font/ttf;base64,AA==",
      logoLightDataURL: "data:image/svg+xml,%3Csvg/%3E",
      logoDarkDataURL: "data:image/svg+xml,%3Csvg/%3E",
    }).replace(
      '<html lang="zh-CN">',
      '<html lang="zh-CN" data-startup-theme="dark">',
    ),
    { runScripts: "outside-only" },
  );
  source.window.document.documentElement.style.backgroundColor =
    "rgb(33, 30, 33)";
  for (const selector of [".mark", ".wipe", ".track", ".bead"]) {
    const element =
      source.window.document.querySelector<HTMLElement>(selector)!;
    element.style.transform = "matrix(1, 0, 0, 1, 12, 0)";
    element.style.opacity = "0.62";
  }
  page = new JSDOM(
    '<html><head></head><body><div id="real-ui">Real reader</div></body></html>',
    { runScripts: "outside-only", pretendToBeVisual: true },
  );
  motion = Object.assign(new page.window.EventTarget(), { matches: false });
  Object.defineProperty(page.window, "matchMedia", { value: () => motion });
  fontLoad = vi.fn(async () => []);
  Object.defineProperty(page.window.document, "fonts", {
    value: { load: fontLoad },
  });
  decode = vi.fn(async () => {});
  Object.defineProperty(page.window.HTMLImageElement.prototype, "decode", {
    value: decode,
    configurable: true,
  });
  animations = [];
  animate = vi.fn(() => {
    const completion = deferred();
    const animation = {
      ...completion,
      cancel: vi.fn(() => completion.reject(new Error("cancelled"))),
    };
    animations.push(animation);
    return { finished: completion.promise, cancel: animation.cancel };
  });
  Object.defineProperty(page.window.HTMLElement.prototype, "animate", {
    value: animate,
    configurable: true,
  });
  const fakeWindow = (dom: JSDOM) =>
    ({
      isDestroyed: vi.fn(() => false),
      webContents: {
        isDestroyed: vi.fn(() => false),
        // Evaluate the actual serialized code in a separate realm. Any captured
        // module binding or bundler helper fails here, as it would in Electron.
        executeJavaScript: vi.fn(async (script: string) =>
          dom.window.eval(script),
        ),
      },
    }) as unknown as BrowserWindow;
  loading = fakeWindow(source);
  target = fakeWindow(page);
});

afterEach(() => {
  current()?.cleanup();
  source.window.close();
  page.window.close();
});

function controlPaint() {
  const frames = new Map<number, FrameRequestCallback>();
  let next = 0;
  let expire!: () => void;
  const request = vi
    .spyOn(page.window, "requestAnimationFrame")
    .mockImplementation((callback) => {
      frames.set(++next, callback);
      return next;
    });
  const cancel = vi
    .spyOn(page.window, "cancelAnimationFrame")
    .mockImplementation((id) => {
      frames.delete(id);
    });
  const timer = vi
    .spyOn(page.window, "setTimeout")
    .mockImplementation((callback) => {
      expire = callback as () => void;
      return 9001;
    });
  const clear = vi
    .spyOn(page.window, "clearTimeout")
    .mockImplementation(() => {});
  return {
    frames,
    request,
    cancel,
    timer,
    clear,
    expire: () => expire(),
    paint: () => {
      const [id, callback] = frames.entries().next().value!;
      frames.delete(id);
      callback(0);
    },
  };
}

it("waits for assets then exactly two paint frames, clearing its watchdog", async () => {
  const paint = controlPaint();
  const font = deferred();
  fontLoad.mockReturnValue(font.promise);
  let prepared = false;
  const preparation = prepareStartupExit(loading, target).then((exit) => {
    prepared = true;
    return exit;
  });
  await vi.waitFor(() => expect(fontLoad).toHaveBeenCalled());
  expect(paint.request).not.toHaveBeenCalled();
  font.resolve();
  await vi.waitFor(() => expect(paint.request).toHaveBeenCalledTimes(1));
  expect(paint.timer).toHaveBeenCalledWith(expect.any(Function), 150);
  expect(prepared).toBe(false);
  paint.paint();
  await Promise.resolve();
  expect(prepared).toBe(false);
  expect(paint.request).toHaveBeenCalledTimes(2);
  paint.paint();
  const exit = await preparation;
  expect(paint.frames.size).toBe(0);
  expect(paint.request).toHaveBeenCalledTimes(2);
  expect(paint.clear).toHaveBeenCalledWith(9001);
  expect(overlay()).not.toBeNull();
  await exit(false);
  assertClean();
});

it.each([0, 1])(
  "bounds stopped painting after %s frames and cancels the remaining frame",
  async (count) => {
    const paint = controlPaint();
    const preparation = prepareStartupExit(loading, target);
    await vi.waitFor(() => expect(paint.request).toHaveBeenCalledTimes(1));
    if (count) paint.paint();
    paint.expire();
    const exit = await preparation;
    expect(paint.cancel).toHaveBeenCalledWith(count + 1);
    expect(paint.frames.size).toBe(0);
    expect(paint.clear).toHaveBeenCalledWith(9001);
    // Timeout releases preparation without removing the handoff overlay.
    expect(overlay()).not.toBeNull();
    await exit(false);
    assertClean();
  },
);

it.each([0, 1])(
  "cancels frame and watchdog when navigation interrupts paint %s",
  async (count) => {
    const paint = controlPaint();
    const preparation = prepareStartupExit(loading, target);
    await vi.waitFor(() => expect(paint.request).toHaveBeenCalledTimes(1));
    if (count) paint.paint();
    page.window.dispatchEvent(new page.window.Event("pagehide"));
    const exit = await preparation;
    expect(paint.cancel).toHaveBeenCalledWith(count + 1);
    expect(paint.frames.size).toBe(0);
    expect(paint.clear).toHaveBeenCalledWith(9001);
    await exit(false);
    assertClean();
  },
);

it("installs a frozen, isolated snapshot over the real UI with global embedded fonts", async () => {
  const original = source.window.document.querySelector("main")!.outerHTML;
  await prepareStartupExit(loading, target);
  expect(source.window.document.querySelector("main")!.outerHTML).toBe(
    original,
  );
  expect(overlay()!.style).toMatchObject({
    position: "fixed",
    inset: "0",
    zIndex: "2147483647",
    pointerEvents: "auto",
  });
  expect(overlay()!.getAttribute("aria-hidden")).toBe("true");
  const surface = shadow().querySelector<HTMLElement>(".surface")!;
  expect(surface.dataset.startupTheme).toBe("dark");
  for (const selector of [".mark", ".wipe", ".track", ".bead"]) {
    expect(surface.querySelector<HTMLElement>(selector)!.style).toMatchObject({
      transform: "matrix(1, 0, 0, 1, 12, 0)",
      opacity: "0.62",
    });
  }
  const css = shadow().querySelector("style")!.textContent!;
  expect(css).not.toMatch(/:root|\bbody\b|@font-face/);
  expect(css).toContain('.surface[data-startup-theme="dark"]');
  expect(css).toContain("background:transparent !important");
  expect(page.window.document.head.textContent).toContain("@font-face");
  expect(page.window.document.head.textContent).toContain("data:font/ttf");
  expect(fontLoad).toHaveBeenCalledWith('600 46px "NeoRead Caveat"');
  expect(decode).toHaveBeenCalledTimes(2);
  expect(shadow().querySelector("script")).toBeNull();
  expect(animate).not.toHaveBeenCalled();
  const veil = shadow().querySelector<HTMLElement>(".veil")!;
  expect(veil.style.width).toBe(
    `${Math.hypot(page.window.innerWidth, page.window.innerHeight) * 1.5}px`,
  );
  expect(veil.style.background).toContain("rgb(33, 30, 33) 72%");
  expect(veil.style.background).toContain("transparent 100%");
  Object.defineProperty(page.window, "innerWidth", { value: 600 });
  page.window.dispatchEvent(new page.window.Event("resize"));
  expect(veil.style.width).toBe(
    `${Math.hypot(600, page.window.innerHeight) * 1.5}px`,
  );
});

it("waits for fonts and images, tolerating failed embedded assets", async () => {
  const font = deferred();
  const image = deferred();
  fontLoad.mockReturnValue(font.promise);
  decode.mockReturnValue(image.promise);
  let prepared = false;
  const preparation = prepareStartupExit(loading, target).then(() => {
    prepared = true;
  });
  await vi.waitFor(() => expect(overlay()).not.toBeNull());
  expect(prepared).toBe(false);
  font.reject(new Error("bad font"));
  await Promise.resolve();
  expect(prepared).toBe(false);
  image.reject(new Error("bad image"));
  await preparation;
  expect(prepared).toBe(true);
});

it("runs the accepted 600ms veil and 288ms delayed surface fade only once", async () => {
  const exit = await prepareStartupExit(loading, target);
  const pending = exit();
  expect(animate).toHaveBeenCalledTimes(2);
  expect(animate.mock.calls[0]).toEqual([
    [
      { transform: "scale(1)", opacity: 1 },
      { transform: "scale(0)", opacity: 0 },
    ],
    { duration: 600, easing: "cubic-bezier(.4,0,.2,1)", fill: "forwards" },
  ]);
  expect(animate.mock.calls[1]).toEqual([
    [{ opacity: 1 }, { opacity: 0 }],
    { duration: 288, delay: 108, easing: "ease-out", fill: "forwards" },
  ]);
  const repeated = exit();
  expect(animate).toHaveBeenCalledTimes(2);
  animations[1].resolve();
  await Promise.resolve();
  expect(overlay()).not.toBeNull();
  animations[0].resolve();
  await Promise.all([pending, repeated]);
  assertClean();
  await exit();
  assertClean();
});

it.each([false, true])(
  "false immediately cleans up, including running animation: %s",
  async (started) => {
    const exit = await prepareStartupExit(loading, target);
    const pending = started ? exit() : Promise.resolve();
    await exit(false);
    await pending;
    assertClean();
    expect(animate).toHaveBeenCalledTimes(started ? 2 : 0);
  },
);

it("skips motion when reduced motion was already enabled", async () => {
  motion.matches = true;
  const exit = await prepareStartupExit(loading, target);
  await exit();
  expect(animate).not.toHaveBeenCalled();
  assertClean();
});

it("keeps the snapshot while preparing a hidden target, then animates after showing", async () => {
  const hidden = vi
    .spyOn(page.window.document, "hidden", "get")
    .mockReturnValue(true);
  const exit = await prepareStartupExit(loading, target);
  page.window.document.dispatchEvent(new page.window.Event("visibilitychange"));
  expect(overlay()).not.toBeNull();
  expect(animate).not.toHaveBeenCalled();
  hidden.mockReturnValue(false);
  page.window.document.dispatchEvent(new page.window.Event("visibilitychange"));
  const pending = exit();
  expect(animate).toHaveBeenCalledTimes(2);
  animations.forEach((animation) => animation.resolve());
  await pending;
  assertClean();
});

it("cleans immediately if exit is requested while the target is hidden", async () => {
  const exit = await prepareStartupExit(loading, target);
  vi.spyOn(page.window.document, "hidden", "get").mockReturnValue(true);
  await exit();
  expect(animate).not.toHaveBeenCalled();
  assertClean();
});

it("releases a running exit on hiding without waiting for paused animations", async () => {
  const remove = vi.spyOn(page.window.document, "removeEventListener");
  const exit = await prepareStartupExit(loading, target);
  const pending = exit();
  vi.spyOn(page.window.document, "hidden", "get").mockReturnValue(true);
  page.window.document.dispatchEvent(new page.window.Event("visibilitychange"));
  await pending;
  assertClean();
  expect(remove).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
  for (const animation of animations)
    expect(animation.cancel).toHaveBeenCalledOnce();
});

it.each(["pagehide", "beforeunload", "reduced-motion", "cancel"])(
  "cleans a running transition on %s and removes listeners",
  async (reason) => {
    const remove = vi.spyOn(page.window, "removeEventListener");
    const removeMotion = vi.spyOn(motion, "removeEventListener");
    const exit = await prepareStartupExit(loading, target);
    const pending = exit();
    if (reason === "reduced-motion") {
      motion.matches = true;
      motion.dispatchEvent(new page.window.Event("change"));
    } else if (reason === "cancel") animations[0].cancel();
    else page.window.dispatchEvent(new page.window.Event(reason));
    await pending;
    assertClean();
    for (const event of ["pagehide", "beforeunload", "resize"])
      expect(remove).toHaveBeenCalledWith(event, expect.any(Function));
    expect(removeMotion).toHaveBeenCalledWith("change", expect.any(Function));
  },
);

it("releases pending asset preparation on navigation", async () => {
  fontLoad.mockReturnValue(new Promise(() => {}));
  const preparation = prepareStartupExit(loading, target);
  await vi.waitFor(() => expect(current()).toBeDefined());
  page.window.dispatchEvent(new page.window.Event("pagehide"));
  const exit = await preparation;
  await exit(false);
  assertClean();
});

it("cleans the previous private entry before installing another overlay", async () => {
  const first = await prepareStartupExit(loading, target);
  const pending = first();
  const oldOverlay = overlay()!;
  const second = await prepareStartupExit(loading, target);
  await pending;
  expect(oldOverlay.isConnected).toBe(false);
  expect(
    page.window.document.querySelectorAll("[data-neoread-startup-exit]"),
  ).toHaveLength(1);
  expect(
    page.window.document.querySelectorAll("[data-neoread-startup-exit-fonts]"),
  ).toHaveLength(1);
  await second(false);
  assertClean();
});

it.each([0, 1])("cleans up if animation %s fails to start", async (index) => {
  const exit = await prepareStartupExit(loading, target);
  if (index === 1)
    animate.mockImplementationOnce(animate.getMockImplementation()!);
  animate.mockImplementationOnce(() => {
    throw new Error("renderer unavailable");
  });
  await exit();
  assertClean();
});

it("does not execute exit code in a destroyed target", async () => {
  const exit = await prepareStartupExit(loading, target);
  vi.mocked(target.isDestroyed).mockReturnValue(true);
  await exit(false);
  expect(target.webContents.executeJavaScript).toHaveBeenCalledTimes(1);
});
