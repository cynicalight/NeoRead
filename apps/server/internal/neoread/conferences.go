package neoread

import (
	_ "embed"
	"encoding/json"
	"regexp"
)

//go:embed conferences.json
var conferenceCatalogJSON []byte

type conferenceEntry struct {
	Abbreviation string `json:"abbreviation"`
	FullName     string `json:"fullName"`
	Pattern      string `json:"pattern"`
	matcher      *regexp.Regexp
}

// The embedded catalog is shared with the web client. Invalid built-in data is
// a programming error, not an unknown user-supplied venue.
var conferenceCatalog = func() []conferenceEntry {
	var entries []conferenceEntry
	if err := json.Unmarshal(conferenceCatalogJSON, &entries); err != nil {
		panic(err)
	}
	for i := range entries {
		entries[i].matcher = regexp.MustCompile(entries[i].Pattern)
	}
	return entries
}()

func matchConference(venue string) (conferenceEntry, bool) {
	name := journalName(venue)
	for _, entry := range conferenceCatalog {
		if entry.matcher.MatchString(name) {
			return entry, true
		}
	}
	return conferenceEntry{}, false
}
