import { expect, it } from "vitest";
import type { Document, Processing } from "@reader/core";
import { paper } from "./fixtures";
import { relatedCandidates } from "./RelatedPapers";
import {
  authorsShort,
  formatCreators,
  paperByline,
  paperLink,
  parseCreators,
  shortTitle,
  publicationDate,
  wasOpened,
} from "./format";
import {
  categoryTree,
  cleanCategory,
  duplicateGroups,
  pairKey,
  paperColors,
  setCategoryColor,
  removeSmartCategory,
  saveSmartCategory,
  paperTags,
  sortPapers,
  toggleColumn,
  filterPapers,
  flattenCategories,
  matchesView,
  moveCategory,
  paperCategories,
  recentPapers,
  removeCategoryPreferences,
  renameCategoryPreferences,
  setHidden,
  siblingPosition,
  togglePinned,
  validCategory,
} from "./model";

it("formats author lists by script and falls back to the display author", () => {
  const four = paper({
    metadata: {
      creators: [
        { given: "Ashish", family: "Vaswani" },
        { given: "Noam", family: "Shazeer" },
        { given: "Niki", family: "Parmar" },
        { given: "Jakob", family: "Uszkoreit" },
      ],
    },
  });
  expect(authorsShort(four)).toBe(
    "Ashish Vaswani, Noam Shazeer, Niki Parmar et al.",
  );
  expect(authorsShort(paper({ author: "张三，李四；王五, 赵六" }))).toBe(
    "张三, 李四, 王五 等",
  );
  expect(
    paperByline(
      paper({
        author: "Ada",
        metadata: { date: "2017-06-12", arxiv: "1706.03762" },
      }),
    ),
  ).toBe("Ada · 2017 · arXiv:1706.03762");
});

it("parses one author per line and formats them back", () => {
  const creators = parseCreators(
    "Vaswani, Ashish\nNoam Shazeer\n张三\nPlato\n",
  );
  expect(creators).toEqual([
    { family: "Vaswani", given: "Ashish" },
    { given: "Noam", family: "Shazeer" },
    { name: "张三" },
    { name: "Plato" },
  ]);
  expect(formatCreators(creators)).toBe(
    "Vaswani, Ashish\nShazeer, Noam\n张三\nPlato",
  );
});

it("derives links and short titles", () => {
  expect(paperLink({ arxiv: "1706.03762v5" })).toBe(
    "https://arxiv.org/abs/1706.03762",
  );
  expect(paperLink({ doi: "10.1000/x" })).toBe("https://doi.org/10.1000/x");
  expect(paperLink({ url: "https://a.org", doi: "10.1000/x" })).toBe(
    "https://a.org",
  );
  expect(shortTitle(paper({ title: "BERT: Pre-training of Deep" }))).toBe(
    "BERT",
  );
  expect(shortTitle(paper({ title: "AI: A Survey" }))).toBe("AI: A Survey");
  expect(shortTitle(paper({ title: "Scaling Laws: A Study" }))).toBe(
    "Scaling Laws",
  );
  expect(shortTitle(paper({ metadata: { shortTitle: "Transformer" } }))).toBe(
    "Transformer",
  );
});

it("filters by view and every search term, then sorts", () => {
  const docs = [
    paper({
      id: "a",
      title: "Alpha",
      folders: ["ML"],
      readingStatus: "reading",
      metadata: { date: "2020", venue: "NeurIPS" },
    }),
    paper({
      id: "b",
      title: "Beta",
      favorite: true,
      metadata: { date: "2023", abstract: "graph neural networks" },
    }),
    paper({ id: "c", title: "Gamma", folders: ["ml"] }),
  ];
  const jobs = new Map<string, Processing>([
    ["c", { documentId: "c", status: "running" } as Processing],
  ]);
  const ids = (list: Document[]) => list.map((d) => d.id);
  expect(ids(filterPapers(docs, "folder:ML", "", "title", jobs))).toEqual([
    "a",
    "c",
  ]);
  expect(ids(filterPapers(docs, "reading", "", "title", jobs))).toEqual(["a"]);
  expect(ids(filterPapers(docs, "starred", "", "title", jobs))).toEqual(["b"]);
  expect(ids(filterPapers(docs, "processing", "", "title", jobs))).toEqual([
    "c",
  ]);
  expect(
    ids(filterPapers(docs, "all", "graph NETWORKS", "title", jobs)),
  ).toEqual(["b"]);
  expect(ids(filterPapers(docs, "all", "graph alpha", "title", jobs))).toEqual(
    [],
  );
  expect(ids(filterPapers(docs, "all", "", "year", jobs))).toEqual([
    "b",
    "a",
    "c",
  ]);
});

it("keeps saved category order and appends folders found on papers", () => {
  const docs = [
    paper({ folders: ["Zeta", "alpha"] }),
    paper({ folders: ["Beta"] }),
  ];
  expect(paperCategories({ categories: ["Alpha", "Empty"] }, docs)).toEqual([
    "Alpha",
    "Empty",
    "Beta",
    "Zeta",
  ]);
  expect(moveCategory(["a", "b", "c"], "c", -1)).toEqual(["a", "c", "b"]);
  expect(moveCategory(["a", "b"], "a", -1)).toEqual(["a", "b"]);
});

it("updates pinned and hidden keys when categories change", () => {
  const prefs = {
    pinned: ["folder:ML", "doc:x"],
    hidden: ["folder:ML", "view:done"],
  };
  expect(renameCategoryPreferences(prefs, ["ML", "CV"], "ML", "NLP")).toEqual({
    categories: ["NLP", "CV"],
    pinned: ["folder:NLP", "doc:x"],
    hidden: ["folder:NLP", "view:done"],
  });
  expect(removeCategoryPreferences(prefs, ["ML", "CV"], "ML")).toEqual({
    categories: ["CV"],
    pinned: ["doc:x"],
    hidden: ["view:done"],
  });
  expect(togglePinned({ pinned: ["a"] }, "b").pinned).toEqual(["b", "a"]);
  expect(togglePinned({ pinned: ["a"] }, "a").pinned).toEqual([]);
  expect(setHidden({ hidden: ["x"] }, "x", false).hidden).toEqual([]);
});

it("lists recently opened papers without pinned ones", () => {
  const docs = [
    paper({ id: "new" }),
    paper({ id: "old", lastOpenedAt: "2026-10-03T00:00:00Z" }),
    paper({ id: "pinned", lastOpenedAt: "2026-10-04T00:00:00Z" }),
    paper({ id: "latest", lastOpenedAt: "2026-10-05T00:00:00Z" }),
  ];
  expect(recentPapers(docs, ["doc:pinned"]).map((d) => d.id)).toEqual([
    "latest",
    "old",
  ]);
});

it("nests categories by slash and lists implied parents", () => {
  const docs = [
    paper({ id: "a", folders: ["ML/Vision/Detection"] }),
    paper({ id: "b", folders: ["ML"] }),
    paper({ id: "c", folders: [] }),
  ];
  const categories = paperCategories(
    { categories: ["Reading", "ml/NLP"] },
    docs,
  );
  expect(categories).toEqual([
    "Reading",
    "ml",
    "ml/NLP",
    "ML/Vision",
    "ML/Vision/Detection",
  ]);
  const flat = flattenCategories(categoryTree(categories)).map(
    (n) => `${n.depth}:${n.label}`,
  );
  expect(flat).toEqual([
    "0:Reading",
    "0:ml",
    "1:NLP",
    "1:Vision",
    "2:Detection",
  ]);
  expect(
    flattenCategories(categoryTree(categories), (n) => n.name === "ml").map(
      (n) => n.name,
    ),
  ).toEqual(["Reading", "ml"]);
  const jobs = new Map();
  expect(matchesView(docs[0], "folder:ML", jobs)).toBe(true);
  expect(
    matchesView(docs[0], "folder:ML", jobs, { subcategories: false }),
  ).toBe(false);
  expect(matchesView(docs[0], "folder:ML/Vis", jobs)).toBe(false);
  expect(docs.filter((d) => matchesView(d, "unfiled", jobs))).toEqual([
    docs[2],
  ]);
  expect(cleanCategory(" ML / Vision ")).toBe("ML/Vision");
  expect(validCategory("ML//Vision")).toBe(false);
  expect(validCategory("ML/Vision")).toBe(true);
});

it("moves, renames and removes a category with its subcategories", () => {
  const categories = ["A", "A/x", "A/y", "B", "B/z"];
  expect(moveCategory(categories, "B", -1)).toEqual([
    "B",
    "B/z",
    "A",
    "A/x",
    "A/y",
  ]);
  expect(moveCategory(categories, "A/y", -1)).toEqual([
    "A",
    "A/y",
    "A/x",
    "B",
    "B/z",
  ]);
  expect(moveCategory(categories, "A/x", -1)).toEqual(categories);
  expect(siblingPosition(categories, "A/y")).toEqual({ index: 1, count: 2 });
  const prefs = {
    pinned: ["folder:A/x", "folder:AB"],
    hidden: ["folder:A"],
    collapsed: ["A", "B"],
  };
  expect(renameCategoryPreferences(prefs, categories, "A", "C")).toEqual({
    categories: ["C", "C/x", "C/y", "B", "B/z"],
    pinned: ["folder:C/x", "folder:AB"],
    hidden: ["folder:C"],
    collapsed: ["C", "B"],
  });
  expect(removeCategoryPreferences(prefs, categories, "A")).toEqual({
    categories: ["B", "B/z"],
    pinned: ["folder:AB"],
    hidden: [],
    collapsed: ["B"],
  });
});

it("groups probable duplicates by identifier or title", () => {
  const docs = [
    paper({
      id: "pre",
      title: "Attention Is All You Need",
      createdAt: "2026-01-01",
      metadata: {
        arxiv: "1706.03762v5",
        doi: "10.48550/arXiv.1706.03762",
        date: "2017",
      },
    }),
    paper({
      id: "pub",
      title: "Attention is all you need.",
      createdAt: "2026-02-01",
      metadata: { doi: "10.5555/3295222.3295349", date: "2017-12" },
    }),
    paper({ id: "v1", title: "Other", metadata: { arxiv: "1706.03762v1" } }),
    paper({
      id: "same-title-other-doi",
      title: "Attention Is All You Need",
      metadata: { doi: "10.1000/other", date: "2017" },
    }),
    paper({
      id: "same-title-years-apart",
      title: "A Survey of Graph Neural Networks",
      metadata: { date: "2019" },
    }),
    paper({
      id: "survey",
      title: "A survey of graph neural networks",
      metadata: { date: "2023" },
    }),
  ];
  const ids = (groups: ReturnType<typeof duplicateGroups>) =>
    groups.map((group) => group.map((d) => d.id));
  // The arXiv DOI does not conflict with the published DOI; "v1" shares the
  // arXiv ID. A different published DOI or distant years are different works,
  // unless another identifier links them.
  expect(ids(duplicateGroups(docs))).toEqual([
    ["pre", "pub", "v1", "same-title-other-doi"],
  ]);
  expect(
    ids(duplicateGroups(docs.slice(1, 4), [pairKey("pub", "v1")])),
  ).toEqual([]);
  expect(
    ids(duplicateGroups(docs.slice(0, 3), [pairKey("pub", "pre")])),
  ).toEqual([["pre", "v1"]]);
});

it("keeps up to nine colored categories in key order", () => {
  let prefs = {};
  for (let i = 0; i < 9; i++)
    prefs = setCategoryColor(prefs, `c${i}`, "#e5534b")!;
  expect(setCategoryColor(prefs, "c9", "#e5534b")).toBeNull();
  prefs = setCategoryColor(prefs, "c3", "#4a8fe0")!;
  prefs = setCategoryColor(prefs, "c0", null)!;
  const colored = (
    prefs as { colorCategories: { name: string; color: string }[] }
  ).colorCategories;
  expect(colored).toHaveLength(8);
  expect(colored[2]).toEqual({ name: "c3", color: "#4a8fe0" });
  expect(
    paperColors(paper({ folders: ["c3/x", "c5"] }), colored).map((c) => c.name),
  ).toEqual(["c3", "c5"]);
});

it("offers unlinked papers matching every term as related candidates", () => {
  const doc = paper({ id: "a", title: "Attention", related: ["b"] });
  const docs = [
    doc,
    paper({ id: "b", title: "Graph attention" }),
    paper({ id: "c", title: "Attention maps", metadata: { date: "2020" } }),
    paper({ id: "d", title: "Attention maps", library: "books" }),
  ];
  expect(
    relatedCandidates(doc, docs, "attention 2020").map((d) => d.id),
  ).toEqual(["c"]);
  expect(relatedCandidates(doc, docs, " ")).toEqual([]);
});

it("sorts by every column in either direction", () => {
  const docs = [
    paper({
      id: "a",
      title: "B title",
      readingStatus: "done",
      noteCount: 1,
      metadata: { creators: [{ given: "Z", family: "Zhang" }], venue: "ICML" },
    }),
    paper({
      id: "b",
      title: "A title",
      readingStatus: "reading",
      highlightCount: 5,
      metadata: { creators: [{ name: "Alpha" }] },
    }),
    paper({ id: "c", title: "C title", metadata: { venue: "ACL" } }),
  ];
  const ids = (sort: Parameters<typeof sortPapers>[1], reverse = false) =>
    sortPapers(docs, sort, reverse).map((d) => d.id);
  expect(ids("author")).toEqual(["b", "a", "c"]);
  expect(ids("venue")).toEqual(["c", "a", "b"]);
  expect(ids("status")).toEqual(["b", "c", "a"]);
  expect(ids("notes")).toEqual(["b", "a", "c"]);
  expect(ids("title", true)).toEqual(["c", "a", "b"]);
  expect(toggleColumn(["status", "authors"], "year")).toEqual([
    "authors",
    "year",
    "status",
  ]);
  expect(toggleColumn(["authors", "year"], "authors")).toEqual(["year"]);
});

it("lists tag views and smart tag categories that need every tag", () => {
  const docs = [
    paper({ id: "a", tags: ["LLM", "RL"] }),
    paper({ id: "b", tags: ["llm"] }),
    paper({ id: "c", tags: ["RL"], folders: ["Survey"] }),
  ];
  const jobs = new Map<string, Processing>();
  let prefs = saveSmartCategory(
    { pinned: ["smart:s"] },
    { id: "s", name: " RLHF ", tags: ["llm", " RL", "LLM", ""] },
  );
  expect(prefs.smartCategories).toEqual([
    { id: "s", name: "RLHF", tags: ["llm", "RL"] },
  ]);
  const smart = prefs.smartCategories;
  const ids = (view: Parameters<typeof filterPapers>[1]) =>
    filterPapers(docs, view, "", "title", jobs, { smart }).map((d) => d.id);
  expect(ids("smart:s")).toEqual(["a"]);
  expect(ids("tag:LLM")).toEqual(["a", "b"]);
  expect(ids("unfiled")).toEqual(["a", "b"]);
  expect(ids("smart:missing")).toEqual([]);
  expect(paperTags(docs)).toEqual(["LLM", "RL"]);
  prefs = removeSmartCategory(prefs, "s");
  expect(prefs.smartCategories).toEqual([]);
  expect(prefs.pinned).toEqual([]);
});

it("excludes paused and disabled work from the processing view", () => {
  const doc = paper({ id: "zotero" });
  const job: Processing = {
    documentId: doc.id,
    enabled: false,
    phase: "learning",
    status: "paused",
    pagesDone: 0,
    pagesTotal: 0,
    translationsDone: 0,
    translationsTotal: 0,
    detail: "翻译未开始",
    updatedAt: "2026-10-10T09:00:00Z",
  };
  const matches = (patch: Partial<Processing>) =>
    matchesView(doc, "processing", new Map([[doc.id, { ...job, ...patch }]]));
  expect(matches({})).toBe(false);
  expect(matches({ enabled: true, status: "paused" })).toBe(false);
  expect(matches({ enabled: false, status: "queued" })).toBe(false);
  for (const status of ["queued", "running", "waiting"] as const)
    expect(matches({ enabled: true, status })).toBe(true);
  for (const status of ["complete", "failed"] as const)
    expect(matches({ enabled: true, status })).toBe(false);
});

it("preserves partial publication dates and rejects invalid calendar dates", () => {
  expect(publicationDate("2024")?.label).toBe("2024");
  expect(publicationDate("2024-2")?.label).toBe("2024-02");
  expect(publicationDate("2024-2-29")?.label).toBe("2024-02-29");
  for (const value of [
    "",
    "unknown",
    "2023-02-29",
    "2024-04-31",
    "2024-13",
    "0000",
    "2024-00-01",
  ]) {
    expect(publicationDate(value)).toBeUndefined();
  }
});

it("sorts full and partial dates chronologically with unknown dates last in both directions", () => {
  const docs = [
    "2024-10-02",
    "2024",
    "2024-2",
    "2024-02-29",
    "",
    "invalid",
  ].map((date, i) =>
    paper({ id: String(i), title: String(i), metadata: { date } }),
  );
  expect(sortPapers(docs, "published").map((d) => d.id)).toEqual([
    "0",
    "3",
    "2",
    "1",
    "4",
    "5",
  ]);
  expect(sortPapers(docs, "published", true).map((d) => d.id)).toEqual([
    "1",
    "2",
    "3",
    "0",
    "4",
    "5",
  ]);
  // Year sorting must not silently compare the month or day.
  expect(sortPapers(docs, "year").map((d) => d.id)).toEqual([
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
  ]);
  expect(sortPapers([...docs].reverse(), "published").map((d) => d.id)).toEqual(
    ["0", "3", "2", "1", "4", "5"],
  );
});

it("keeps never-opened imports after opened papers and uses real timestamps across offsets", () => {
  const docs = [
    paper({ id: "new", lastOpenedAt: "", createdAt: "2026-10-16T00:00:00Z" }),
    paper({ id: "legacy", title: "Legacy" }),
    paper({ id: "later", lastOpenedAt: "2026-10-15T00:00:00Z" }),
    paper({ id: "earlier", lastOpenedAt: "2026-10-15T07:00:00+08:00" }),
  ];
  expect(sortPapers(docs, "opened").map((d) => d.id)).toEqual([
    "later",
    "earlier",
    "new",
    "legacy",
  ]);
  expect(sortPapers(docs, "opened", true).map((d) => d.id)).toEqual([
    "earlier",
    "later",
    "new",
    "legacy",
  ]);
  expect(recentPapers(docs, []).map((d) => d.id)).toEqual(["later", "earlier"]);
  expect(wasOpened(paper({ progress: { type: "pdf", page: 1 } }))).toBe(true);
});
