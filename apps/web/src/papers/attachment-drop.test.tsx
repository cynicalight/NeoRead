// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAttachmentDrop, attachmentDwellMs } from "./attachment-drop";
import { uploadAttachments } from "./attachments";
import { paper } from "./fixtures";
vi.mock("./attachments", () => ({
  uploadAttachments: vi.fn(),
  useAttachments: (
    select: (state: { uploads: Record<string, undefined> }) => unknown,
  ) => select({ uploads: {} }),
}));
let root: Root, host: HTMLDivElement;
const imported = vi.fn();
const file = new File(["supplement"], "supplement.pdf");
function Row({ id, immediate = false }: { id: string; immediate?: boolean }) {
  const { armed, ...events } = useAttachmentDrop(paper({ id }), immediate);
  return (
    <div data-row={id} data-armed={armed} {...events}>
      <span>Paper {id}</span>
    </div>
  );
}
const row = (id: string) =>
  host.querySelector<HTMLElement>(`[data-row="${id}"]`)!;
function drag(
  id: string,
  type: string,
  options: {
    x?: number;
    y?: number;
    types?: string[];
    files?: File[];
    relatedTarget?: Node | null;
  } = {},
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    dataTransfer: {
      value: {
        types: options.types || ["Files"],
        files: options.files || [file],
        dropEffect: "none",
      },
    },
    clientX: { value: options.x || 0 },
    clientY: { value: options.y || 0 },
    relatedTarget: { value: options.relatedTarget || null },
  });
  row(id).dispatchEvent(event);
}
beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <div onDrop={imported}>
        <Row id="a" />
        <Row id="b" />
      </div>,
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("keeps a quick drop on a paper in the normal import flow", async () => {
  await act(async () => {
    drag("a", "dragover");
    vi.advanceTimersByTime(attachmentDwellMs - 1);
    drag("a", "drop");
  });
  expect(imported).toHaveBeenCalledOnce();
  expect(uploadAttachments).not.toHaveBeenCalled();
  expect(row("a").dataset.armed).toBe("false");
});
it.each(["zip", "rar", "doc", "docx", "md", "xls", "xlsx", "csv"])(
  "adds a quick %s drop as an attachment instead of importing a paper",
  async (extension) => {
    const supplement = new File([extension], `supplement.${extension}`);
    await act(async () => drag("a", "drop", { files: [file, supplement] }));
    expect(uploadAttachments).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "a" }),
      [file, supplement],
    );
    expect(imported).not.toHaveBeenCalled();
  },
);
it("arms only after dwelling and consumes an attachment drop", async () => {
  await act(async () => {
    drag("a", "dragover");
    vi.advanceTimersByTime(attachmentDwellMs);
  });
  expect(row("a").dataset.armed).toBe("true");
  await act(async () => drag("a", "drop"));
  expect(uploadAttachments).toHaveBeenCalledWith(
    expect.objectContaining({ id: "a" }),
    [file],
  );
  expect(imported).not.toHaveBeenCalled();
  expect(row("a").dataset.armed).toBe("false");
});
it("resets dwell when moving across a row or entering a different paper", async () => {
  await act(async () => {
    drag("a", "dragover");
    vi.advanceTimersByTime(500);
    drag("a", "dragover", { x: 30 });
    vi.advanceTimersByTime(500);
  });
  expect(row("a").dataset.armed).toBe("false");
  await act(async () => {
    drag("b", "dragover");
    vi.advanceTimersByTime(attachmentDwellMs - 1);
  });
  expect(row("a").dataset.armed).toBe("false");
  expect(row("b").dataset.armed).toBe("false");
  await act(async () => {
    vi.advanceTimersByTime(1);
  });
  expect(row("b").dataset.armed).toBe("true");
});
it("disarms after leaving, cancelling or losing window focus", async () => {
  await act(async () => {
    drag("a", "dragover");
    vi.advanceTimersByTime(attachmentDwellMs);
    drag("a", "dragleave");
    vi.advanceTimersByTime(attachmentDwellMs);
  });
  expect(row("a").dataset.armed).toBe("false");
  for (const event of ["dragend", "blur"]) {
    await act(async () => {
      drag("a", "dragover");
      vi.advanceTimersByTime(attachmentDwellMs);
      window.dispatchEvent(new Event(event));
    });
    expect(row("a").dataset.armed).toBe("false");
  }
});
it("ignores Reader's internal paper drags", async () => {
  await act(async () => {
    drag("a", "dragover", { types: ["application/x-reader-papers"] });
    vi.advanceTimersByTime(attachmentDwellMs);
  });
  expect(row("a").dataset.armed).toBe("false");
});

it("accepts files immediately in an expanded attachment area", async () => {
  await act(async () =>
    root.render(
      <div onDrop={imported}>
        <Row id="a" immediate />
      </div>,
    ),
  );
  await act(async () => drag("a", "dragover"));
  expect(row("a").dataset.armed).toBe("true");
  await act(async () => drag("a", "drop"));
  expect(uploadAttachments).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ id: "a" }),
    [file],
  );
  expect(imported).not.toHaveBeenCalled();
});
it("restores the dwell requirement immediately after collapsing", async () => {
  await act(async () =>
    root.render(
      <div onDrop={imported}>
        <Row id="a" immediate />
      </div>,
    ),
  );
  await act(async () => drag("a", "dragover"));
  await act(async () =>
    root.render(
      <div onDrop={imported}>
        <Row id="a" />
      </div>,
    ),
  );
  expect(row("a").dataset.armed).toBe("false");
  await act(async () => {
    drag("a", "dragover");
    drag("a", "drop");
  });
  expect(uploadAttachments).not.toHaveBeenCalled();
  expect(imported).toHaveBeenCalledOnce();
});
it("accepts a direct expanded drop even without a prior dragover event", async () => {
  await act(async () =>
    root.render(
      <div onDrop={imported}>
        <Row id="a" immediate />
      </div>,
    ),
  );
  await act(async () => drag("a", "drop"));
  expect(uploadAttachments).toHaveBeenCalledOnce();
  expect(imported).not.toHaveBeenCalled();
});
