package neoread

import (
	_ "embed"
	"encoding/json"
	"regexp"
	"strings"
)

//go:embed conferences.json
var conferenceCatalogJSON []byte

type conferenceEntry struct {
	Abbreviation string   `json:"abbreviation"`
	FullName     string   `json:"fullName"`
	Aliases      []string `json:"aliases,omitempty"`
}

// Names only, not ratings: CCF seventh edition and official conference sites.
// https://www.ccf.org.cn/Academic_Evaluation/By_category/
// Keep this normalization in sync with web/src/papers/conferences.ts. We remove
// bibliographic wrappers, never arbitrary words such as Workshop or Findings.
var (
	conferenceYear           = regexp.MustCompile(`\b(19|20)[0-9]{2}\b`)
	conferenceOrdinal        = regexp.MustCompile(`\b[0-9]+(st|nd|rd|th)\b`)
	conferenceWrapper        = regexp.MustCompile(`^(proceedings of( the)?|proceedings|the|ieee cvf|ieee rsj|ieee acm|acm ieee|ieee|acm|ifip|usenix association) `)
	conferencePunctuation    = regexp.MustCompile(`[[:space:][:punct:]]+`)
	conferenceAdvancesVolume = regexp.MustCompile(`^(advances in neural information processing systems) [0-9]+\b`)
)

func normalizeConferenceName(value string) string {
	value = strings.ReplaceAll(value, "&", " and ")
	value = strings.ToLower(strings.TrimSpace(value))
	value = conferenceYear.ReplaceAllString(value, " ")
	value = conferenceOrdinal.ReplaceAllString(value, " ")
	value = strings.Join(strings.Fields(conferencePunctuation.ReplaceAllString(value, " ")), " ")
	for {
		stripped := conferenceWrapper.ReplaceAllString(value, "")
		if stripped == value {
			break
		}
		value = stripped
	}
	return conferenceAdvancesVolume.ReplaceAllString(value, "$1")
}

// Invalid embedded data is a programming error. An ambiguous key is deliberately
// unmatchable, so adding a second FSE cannot silently relabel existing papers.
var conferenceCatalog = func() []conferenceEntry {
	var entries []conferenceEntry
	if err := json.Unmarshal(conferenceCatalogJSON, &entries); err != nil {
		panic(err)
	}
	return entries
}()

var conferenceIndex = func() map[string]int {
	index := make(map[string]int, len(conferenceCatalog)*4)
	add := func(name string, position int) {
		key := normalizeConferenceName(name)
		if previous, exists := index[key]; exists && previous != position {
			index[key] = -1
		} else if !exists {
			index[key] = position
		}
	}
	for position, entry := range conferenceCatalog {
		names := append([]string{entry.FullName, entry.Abbreviation}, entry.Aliases...)
		suffixes := []string{entry.Abbreviation}
		for _, alias := range entry.Aliases {
			if len(alias) <= 20 && !strings.ContainsAny(alias, " \t\r\n") {
				suffixes = append(suffixes, alias)
			}
		}
		for _, name := range names {
			add(name, position)
			for _, suffix := range suffixes {
				add(name+" ("+suffix+")", position)
			}
		}
	}
	return index
}()

func matchConference(venue string) (conferenceEntry, bool) {
	position, ok := conferenceIndex[normalizeConferenceName(venue)]
	if !ok || position < 0 {
		return conferenceEntry{}, false
	}
	return conferenceCatalog[position], true
}
