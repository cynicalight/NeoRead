// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { toast } from "sonner";
import { Toaster } from "@neoread/ui/components/sonner";

it("renders toasts outside the isolated app shell, above every layer", async () => {
  const shell = document.createElement("div");
  shell.style.isolation = "isolate";
  document.body.append(shell);
  const root = createRoot(shell);
  await act(async () => root.render(<Toaster />));
  await act(async () => {
    toast("已保存");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const toaster = document.querySelector<HTMLElement>("[data-sonner-toaster]");
  expect(toaster).not.toBeNull();
  expect(shell.contains(toaster)).toBe(false);
  expect(toaster!.style.zIndex).toBe("2147483647");
  act(() => root.unmount());
  shell.remove();
});
