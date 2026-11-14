import conferences from "../../../server/internal/neoread/conferences.json";

const directory = conferences.map((conference) => ({
  ...conference,
  matcher: new RegExp(conference.pattern),
}));

const normalize = (value: string) => value.toLowerCase().trim().replace(/\s+/g, " ");

/** Display only: never replace the stored venue or use this for search/sort. */
export function conferenceVenue(venue: string) {
  const normalized = normalize(venue);
  const conference = directory.find(({ matcher }) => matcher.test(normalized));
  if (!conference) return { label: venue };
  return {
    label: conference.abbreviation,
    fullName: conference.fullName,
    original:
      normalized !== normalize(conference.fullName) && !/^[a-z]+$/.test(normalized)
        ? venue
        : undefined,
  };
}
