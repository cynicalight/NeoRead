import type { AuthInteraction } from "@earendil-works/pi-ai";

export type LoginEvent =
  | { type: "auth_url"; url: string }
  | { type: "device_code"; url: string; code: string }
  | { type: "progress"; phase: "authorizing" | "exchanging" };

/** Keep the SDK's browser callback authoritative; never race it with pasted codes. */
export function loginInteraction(
  signal: AbortSignal,
  send: (event: LoginEvent) => void,
): AuthInteraction & { signal: AbortSignal } {
  return {
    signal,
    notify: (event) => {
      if (event.type === "auth_url") {
        send({ type: "auth_url", url: event.url });
        send({ type: "progress", phase: "authorizing" });
      } else if (event.type === "device_code") {
        send({
          type: "device_code",
          url: event.verificationUri,
          code: event.userCode,
        });
        send({ type: "progress", phase: "authorizing" });
      } else if (event.type === "progress") {
        // Do not forward SDK free text: it may include credentials or URLs.
        send({ type: "progress", phase: "exchanging" });
      }
    },
    prompt: (prompt) => {
      if (prompt.type === "select") {
        const browser = prompt.options.find(
          (option) => option.id === "browser",
        );
        if (browser) return Promise.resolve(browser.id);
        return Promise.reject(new Error("不支持的授权方式"));
      }
      if (prompt.type !== "manual_code")
        return Promise.reject(new Error("不支持的授权提示"));
      // Pi starts this fallback even with an active callback listener. Rejecting
      // it immediately cancels that listener; leave it pending until SDK aborts.
      const pendingSignal = prompt.signal
        ? AbortSignal.any([signal, prompt.signal])
        : signal;
      return new Promise<string>((_resolve, reject) => {
        if (pendingSignal.aborted) return reject(pendingSignal.reason);
        pendingSignal.addEventListener(
          "abort",
          () => reject(pendingSignal.reason),
          { once: true },
        );
      });
    },
  };
}
