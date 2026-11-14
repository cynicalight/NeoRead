// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PaperByline, PaperVenue } from "./PaperVenue";
import { conferenceVenue } from "./conferences";
import { paper } from "./fixtures";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it.each([
  "NeurIPS",
  "Neural Information Processing Systems",
  "Advances in Neural Information Processing Systems 36",
])("shows the canonical name on keyboard focus for %s", async (venue) => {
  await act(async () => root.render(<PaperVenue metadata={{ venue }} />));
  const trigger = host.querySelector<HTMLElement>(
    "[data-slot=tooltip-trigger]",
  )!;
  expect(trigger.textContent).toBe("NeurIPS");
  expect(trigger.hasAttribute("title")).toBe(false);
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
    );
    trigger.focus();
  });
  const tooltip = document.querySelector<HTMLElement>("[role=tooltip]")!;
  expect(tooltip).not.toBeNull();
  expect(tooltip.textContent).toContain(conferenceVenue(venue).fullName);
  if (venue.endsWith("36")) expect(tooltip.textContent).toContain(venue);
  if (venue === "NeurIPS") expect(tooltip.textContent).not.toMatch(/NeurIPS/);
  expect(document.activeElement).toBe(trigger);
  await act(async () => {
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  expect(trigger.getAttribute("aria-describedby")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it("limits the list tooltip to the venue, not its author and year", async () => {
  const doc = paper({
    author: "Ada",
    metadata: { date: "2023", venue: "ICML" },
  });
  await act(async () => root.render(<PaperByline doc={doc} showAuthors />));
  expect(host.textContent).toBe("Ada · 2023 · ICML");
  const trigger = host.querySelector("[data-slot=tooltip-trigger]")!;
  expect(trigger.textContent).toBe("ICML");
  expect(trigger.parentElement!.hasAttribute("title")).toBe(false);
});

it.each(["Unknown Venue", "NeurIPS Workshop on Machine Learning"])(
  "keeps %s unchanged without a misleading tooltip",
  async (venue) => {
    await act(async () => root.render(<PaperVenue metadata={{ venue }} />));
    expect(host.textContent).toBe(venue);
    expect(host.querySelector("[data-slot=tooltip-trigger]")).toBeNull();
  },
);

it.each([
  {
    venue: "International Conference on Long-Tail Engineering",
    venueShort: "ICLTE",
    label: "ICLTE",
    fullName: "International Conference on Long-Tail Engineering",
  },
  {
    venue: "Neural Information Processing Systems",
    venueShort: "Agent abbreviation",
    label: "NeurIPS",
    fullName: conferenceVenue("NeurIPS").fullName!,
  },
])(
  "shows $label with its full name when an Agent abbreviation is present",
  async ({ venue, venueShort, label, fullName }) => {
    await act(async () =>
      root.render(<PaperVenue metadata={{ venue, venueShort }} />),
    );
    const trigger = host.querySelector<HTMLElement>(
      "[data-slot=tooltip-trigger]",
    )!;
    expect(trigger.textContent).toBe(label);
    expect(trigger.hasAttribute("title")).toBe(false);
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
      );
      trigger.focus();
    });
    const tooltip = document.querySelector<HTMLElement>("[role=tooltip]")!;
    expect(tooltip.textContent).toContain(fullName);
    expect(trigger.getAttribute("aria-describedby")).toBe(tooltip.id);
    expect(document.activeElement).toBe(trigger);
    await act(async () => {
      trigger.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(trigger.getAttribute("aria-describedby")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  },
);

it("keeps the original venue metadata and row click behavior", async () => {
  const metadata = {
    venue: "International Conference on Long-Tail Engineering",
    venueShort: "ICLTE",
  };
  const onClick = vi.fn();
  await act(async () =>
    root.render(
      <div onClick={onClick}>
        <PaperByline doc={paper({ metadata })} showAuthors={false} />
      </div>,
    ),
  );
  const trigger = host.querySelector<HTMLElement>(
    "[data-slot=tooltip-trigger]",
  )!;
  expect(trigger.textContent).toBe("ICLTE");
  await act(async () => trigger.click());
  expect(onClick).toHaveBeenCalledOnce();
  expect(metadata.venue).toBe(
    "International Conference on Long-Tail Engineering",
  );
});

it("does not add a byline for an abbreviation without a venue", async () => {
  await act(async () =>
    root.render(
      <PaperByline
        doc={paper({ metadata: { venueShort: "ICLTE" } })}
        showAuthors={false}
      />,
    ),
  );
  expect(host.textContent).toBe("");
  expect(host.querySelector("[data-slot=tooltip-trigger]")).toBeNull();
});
