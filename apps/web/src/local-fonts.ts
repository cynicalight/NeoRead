import { api } from "@neoread/api";

/** Font families installed on this computer, via the Local Font Access API. */
type FontData = { family: string };
type FontQuery = () => Promise<FontData[]>;

export const canQueryLocalFonts = () =>
  typeof (window as { queryLocalFonts?: FontQuery }).queryLocalFonts ===
  "function";

let loaded: string[] = [];
let saved: Promise<string[]> | undefined;

/** Families already known in this session, shared by every reading tab. */
export const loadedLocalFontFamilies = () => loaded;

/**
 * The list read on an earlier launch. The desktop page's origin changes with
 * the server port, so it is kept in the library database, not browser storage.
 */
export function savedLocalFontFamilies(): Promise<string[]> {
  saved ??= api
    .fontPreferences()
    .then(({ families }) => {
      const list = Array.isArray(families)
        ? families.filter((f): f is string => typeof f === "string" && !!f)
        : [];
      if (!loaded.length) loaded = list;
      return loaded;
    })
    .catch(() => {
      saved = undefined;
      return loaded;
    });
  return saved;
}

/**
 * Read installed families, A–Z, and remember them for later launches. Needs a
 * user gesture; a refusal rejects and the next call asks again.
 */
export async function localFontFamilies(): Promise<string[]> {
  const query = (window as { queryLocalFonts?: FontQuery }).queryLocalFonts;
  if (!query) throw new Error("当前环境无法读取本机字体");
  let fonts: FontData[];
  try {
    fonts = await query.call(window);
  } catch (error) {
    throw error instanceof Error && error.name === "SecurityError"
      ? new Error("没有读取本机字体的权限")
      : error;
  }
  loaded = [...new Set(fonts.map((font) => font.family).filter(Boolean))].sort(
    (a, b) => a.localeCompare(b, "zh"),
  );
  saved = Promise.resolve(loaded);
  // The list still works for this session if saving fails.
  if (loaded.length)
    void api.saveFontPreferences({ families: loaded }).catch(() => {});
  return loaded;
}
