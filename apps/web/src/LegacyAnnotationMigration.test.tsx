// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "@neoread/api";
import { LegacyAnnotationMigration } from "./LegacyAnnotationMigration";

vi.mock("@neoread/api", () => ({ api: { migrateLegacyAnnotations: vi.fn() } }));
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.clearAllMocks());
it("migrates only on click, prevents repeated requests, and reports partial results", async () => {
  let finish!: (result: {
    migrated: number;
    skipped: number;
    failed: number;
  }) => void;
  vi.mocked(api.migrateLegacyAnnotations).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const host = document.createElement("div");
  const root = createRoot(host);
  const changed = vi.fn();
  window.addEventListener("neoread:annotations-changed", changed);
  try {
    await act(async () => root.render(<LegacyAnnotationMigration />));
    expect(api.migrateLegacyAnnotations).not.toHaveBeenCalled();
    const button = [...host.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "开始",
    )!;
    expect(button.textContent).toBe("开始");
    await act(async () => button.click());
    expect(button.disabled).toBe(true);
    await act(async () => button.click());
    expect(api.migrateLegacyAnnotations).toHaveBeenCalledTimes(1);
    await act(async () => finish({ migrated: 2, skipped: 1, failed: 1 }));
    expect(button.disabled).toBe(false);
    expect(host.querySelector('[role="status"]')?.textContent).toContain(
      "已迁移 2 条旧版批注，1 项暂未迁移",
    );
    expect(host.textContent).toContain("1 个文档迁移失败");
    expect(changed).not.toHaveBeenCalled();
    vi.mocked(api.migrateLegacyAnnotations).mockRejectedValueOnce(
      new Error("offline"),
    );
    await act(async () => button.click());
    expect(button.disabled).toBe(false);
    expect(host.textContent).toContain("已保存的批注会保留");
  } finally {
    await act(async () => root.unmount());
    window.removeEventListener("neoread:annotations-changed", changed);
  }
});
