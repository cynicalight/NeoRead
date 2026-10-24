/**
 * Bundled CSL styles and locales (CC BY-SA 3.0, see papers/csl/README.md).
 * Files load on first use so the styles stay out of the main bundle.
 */
const styleFiles = import.meta.glob<string>("../papers/csl/*.csl", {
  query: "?raw",
  import: "default",
});
const localeFiles = import.meta.glob<string>("../papers/csl/locales-*.xml", {
  query: "?raw",
  import: "default",
});

export type StyleInfo = { id: string; title: string };

/** Display order in the preferences dialog. */
export const bundledStyles: StyleInfo[] = [
  {
    id: "gb-t-7714-2015-numeric-bilingual",
    title: "GB/T 7714—2015（顺序编码制）",
  },
  {
    id: "gb-t-7714-2015-author-date-bilingual",
    title: "GB/T 7714—2015（著者-出版年制）",
  },
  { id: "gb-t-7714-2015-note-bilingual", title: "GB/T 7714—2015（注释）" },
  {
    id: "gb-t-7714-2025-numeric-bilingual",
    title: "GB/T 7714—2025（顺序编码制）",
  },
  {
    id: "gb-t-7714-2025-author-date-bilingual",
    title: "GB/T 7714—2025（著者-出版年制）",
  },
  { id: "gb-t-7714-2025-note-bilingual", title: "GB/T 7714—2025（注释）" },
  { id: "apa", title: "APA（第 7 版）" },
  { id: "ieee", title: "IEEE" },
  { id: "chicago-author-date", title: "Chicago（著者-日期）" },
  {
    id: "chicago-shortened-notes-bibliography",
    title: "Chicago（注释与参考文献）",
  },
  { id: "modern-language-association", title: "MLA（第 9 版）" },
  { id: "harvard-cite-them-right", title: "Harvard（Cite Them Right）" },
  { id: "nlm-citation-sequence", title: "Vancouver（NLM）" },
  { id: "nature", title: "Nature" },
];

export const bundledLocales = [
  { id: "zh-CN", title: "简体中文" },
  { id: "zh-TW", title: "繁體中文" },
  { id: "en-US", title: "English (US)" },
  { id: "en-GB", title: "English (UK)" },
];

export const DEFAULT_STYLE = bundledStyles[0].id;

export type LoadedStyle = {
  id: string;
  xml: string;
  /** "note" styles put citations into footnotes or endnotes. */
  noteStyle: boolean;
  hasBibliography: boolean;
  defaultLocale: string;
};

const cache = new Map<string, Promise<LoadedStyle>>();

export function loadStyle(id: string): Promise<LoadedStyle> {
  const load = styleFiles[`../papers/csl/${id}.csl`];
  if (!load) return Promise.reject(new Error(`未找到引用样式：${id}`));
  let style = cache.get(id);
  if (!style) {
    style = load().then((xml) => {
      const root = new DOMParser()
        .parseFromString(xml, "application/xml")
        .querySelector("style");
      return {
        id,
        xml,
        noteStyle: root?.getAttribute("class") === "note",
        hasBibliography: /<bibliography[\s>]/.test(xml),
        defaultLocale: root?.getAttribute("default-locale") || "",
      };
    });
    cache.set(id, style);
  }
  return style;
}

let locales: Promise<Map<string, string>> | undefined;
/** citeproc asks for locales synchronously, so all of them load up front. */
export function loadLocales() {
  locales ??= Promise.all(
    Object.entries(localeFiles).map(async ([path, load]) => {
      const id = path.match(/locales-(.+)\.xml$/)?.[1] || "";
      return [id, await load()] as const;
    }),
  ).then((entries) => new Map(entries));
  return locales;
}
