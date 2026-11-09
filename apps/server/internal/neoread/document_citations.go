package neoread

import (
	"regexp"
	"strings"
)

var documentCitationPattern = regexp.MustCompile(`[^]*(?:|)`)

// Accept paired bracket forms actually returned by multilingual providers.
// Only IDs backed by read evidence receive navigation metadata.
const documentSourceList = `S[1-9][0-9]*(?:[ \t]*[,，、;；][ \t]*S[1-9][0-9]*)*`

var documentNativeCitationPattern = regexp.MustCompile(`\[` + documentSourceList + `\]|【` + documentSourceList + `】|［` + documentSourceList + `］|（` + documentSourceList + `）|\(` + documentSourceList + `\)`)
var documentCitationIDPattern = regexp.MustCompile(`S[1-9][0-9]*`)
var documentSourceIDPattern = regexp.MustCompile(`^S[1-9][0-9]*$`)

// Provider markers and NeoRead labels resolve through the same evidence check.
// Unknown IDs and malformed fragments do not block the answer; only known evidence gets navigation.
func documentCitationSources(text string) ([]string, error) {
	sources := []string{}
	// Scan native labels independently: an unrelated provider marker must not
	// hide a source label that the original validator would have checked.
	for _, marker := range documentNativeCitationPattern.FindAllString(text, -1) {
		sources = append(sources, documentCitationIDPattern.FindAllString(marker, -1)...)
	}
	for _, marker := range documentCitationPattern.FindAllString(text, -1) {
		parts := strings.Split(strings.TrimSuffix(strings.TrimPrefix(marker, ""), ""), "")
		kind := parts[0]
		if !strings.HasPrefix(kind, "cite") && !strings.HasPrefix(kind, "filecite") && !strings.HasPrefix("cite", kind) && !strings.HasPrefix("filecite", kind) {
			continue // Other provider marker families are not document citations.
		}
		if !strings.HasSuffix(marker, "") || (kind != "cite" && kind != "filecite") || len(parts) < 2 {
			continue
		}
		for _, source := range parts[1:] {
			if !documentSourceIDPattern.MatchString(source) {
				continue
			}
			sources = append(sources, source)
		}
	}
	return sources, nil
}
