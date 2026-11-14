import conferences from "../../../server/internal/neoread/conferences.json";

// Names only: CCF seventh edition and official conference sites, not ratings.
// https://www.ccf.org.cn/Academic_Evaluation/By_category/
// Keep bibliographic wrapper cleaning in sync with conferences.go. In particular,
// do not strip Workshop, Findings, Demo, or arbitrary substrings from titles.
const normalize = (value: string) => {
  let name = value
    .toLowerCase()
    .trim()
    .replace(/&/g, " and ")
    .replace(/\b(19|20)[0-9]{2}\b/g, " ")
    .replace(/\b[0-9]+(st|nd|rd|th)\b/g, " ")
    .replace(/[\s!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]+/g, " ")
    .trim();
  for (;;) {
    const stripped = name.replace(
      /^(proceedings of( the)?|proceedings|the|ieee cvf|ieee rsj|ieee acm|acm ieee|ieee|acm|ifip|usenix association) /,
      "",
    );
    if (stripped === name) break;
    name = stripped;
  }
  return name.replace(
    /^(advances in neural information processing systems) [0-9]+\b/,
    "$1",
  );
};

type Conference = (typeof conferences)[number];
const directory = new Map<string, Conference | null>();
const addName = (name: string, conference: Conference) => {
  const key = normalize(name);
  if (directory.has(key) && directory.get(key) !== conference) {
    directory.set(key, null); // Ambiguous abbreviations must not silently win.
  } else {
    directory.set(key, conference);
  }
};
for (const conference of conferences) {
  const suffixes = [
    conference.abbreviation,
    ...(conference.aliases ?? []).filter(
      (alias) => alias.length <= 20 && !/\s/.test(alias),
    ),
  ];
  for (const name of [
    conference.fullName,
    conference.abbreviation,
    ...(conference.aliases ?? []),
  ]) {
    addName(name, conference);
    for (const suffix of suffixes) addName(`${name} (${suffix})`, conference);
  }
}

/** Display only: never replace the stored venue or use this for search/sort. */
export function conferenceVenue(venue: string, shortName?: string) {
  const normalized = normalize(venue);
  const conference = directory.get(normalized);
  if (!conference) {
    return shortName?.trim()
      ? { label: shortName.trim(), fullName: venue }
      : { label: venue };
  }
  return {
    label: conference.abbreviation,
    fullName: conference.fullName,
    original:
      normalized !== normalize(conference.fullName) &&
      !/^[a-z]+$/.test(normalized)
        ? venue
        : undefined,
  };
}
