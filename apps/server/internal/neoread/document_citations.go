package neoread

import (
	"regexp"
	"strings"
)

var documentCitationPattern = regexp.MustCompile(`[^]*(?:|)`)

// Accept paired bracket forms actually returned by multilingual providers.
// Only IDs backed by returned original evidence receive navigation metadata.
const documentBlockID = `[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)+`
const documentCitationKey = `(?:` + documentBlockID + `|S[1-9][0-9]*)`
const documentSourceList = documentCitationKey + `(?:[ \t]*[,，、;；][ \t]*` + documentCitationKey + `)*`

var documentNativeCitationPattern = regexp.MustCompile(`\[` + documentSourceList + `\]|【` + documentSourceList + `】|［` + documentSourceList + `］|（` + documentSourceList + `）|\(` + documentSourceList + `\)`)
var documentCitationIDPattern = regexp.MustCompile(documentCitationKey)
var documentSourceIDPattern = regexp.MustCompile(`^S[1-9][0-9]*$`)
var documentBlockIDPattern = regexp.MustCompile(`^` + documentBlockID + `$`)
var documentCitationAliasPattern = regexp.MustCompile(`\[(S[1-9][0-9]*)\][ \t]+(` + documentBlockID + `)(?:$|[^A-Za-z0-9_-])`)
var documentDescribedCitationPattern = regexp.MustCompile(`\[([^\[\]\r\n]*?)\bblockId(?:[ \t]+|[ \t]*[:：=][ \t]*)(` + documentBlockID + `)[ \t]*\]`)

// Only an immediately adjacent exact block ID declares a source alias. Conflicting
// declarations are ambiguous and must never create a guessed navigation target.
func documentCitationAliases(text string) map[string]string {
	aliases := map[string]string{}
	conflicts := map[string]bool{}
	for _, match := range documentCitationAliasPattern.FindAllStringSubmatch(text, -1) {
		source, block := match[1], match[2]
		if previous, exists := aliases[source]; exists && previous != block {
			conflicts[source] = true
		}
		aliases[source] = block
	}
	for source := range conflicts {
		delete(aliases, source)
	}
	return aliases
}

// Provider markers and NeoRead labels resolve through the same evidence check.
// Unknown IDs and malformed fragments do not block the answer; only known evidence gets navigation.
func documentCitationSources(text string) ([]string, error) {
	sources := []string{}
	// Scan native labels independently: an unrelated provider marker must not
	// hide a source label that the original validator would have checked.
	for _, marker := range documentNativeCitationPattern.FindAllString(text, -1) {
		sources = append(sources, documentCitationIDPattern.FindAllString(marker, -1)...)
	}
	// Descriptive markers name their target explicitly; their S label is not
	// an independently issued source ID. Multiple blockId fields are ambiguous.
	for _, match := range documentDescribedCitationPattern.FindAllStringSubmatch(text, -1) {
		if !strings.Contains(match[1], "blockId") {
			sources = append(sources, match[2])
		}
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
			if !documentSourceIDPattern.MatchString(source) && !documentBlockIDPattern.MatchString(source) {
				continue
			}
			sources = append(sources, source)
		}
	}
	return sources, nil
}
