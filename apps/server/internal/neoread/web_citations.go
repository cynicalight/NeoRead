package neoread

import (
	"regexp"
	"strings"
)

var nativeWebSourceID = regexp.MustCompile(`^turn[0-9]+(?:search|view|fetch)[0-9]+$`)

func (c *chatInput) normalizeWebCitations(text string) string {
	if c == nil || !c.WebSearch {
		return text
	}
	return documentCitationPattern.ReplaceAllStringFunc(text, func(marker string) string {
		if !strings.HasSuffix(marker, "") {
			return marker
		}
		parts := strings.Split(strings.TrimSuffix(strings.TrimPrefix(marker, ""), ""), "")
		if len(parts) < 2 || parts[0] != "cite" {
			return marker
		}
		out := []string{}
		for _, source := range parts[1:] {
			if documentSourceIDPattern.MatchString(source) {
				out = append(out, "["+source+"]")
				continue
			}
			if !nativeWebSourceID.MatchString(source) {
				return marker
			}
			// Native search identifiers in historical or generated text have no
			// URL in the Pi search results. Keep them out of the document ledger.
			out = append(out, "〔网页引用未解析，见执行记录〕")
		}
		return strings.Join(out, "")
	})
}

// Only a possible partial citation is buffered; ordinary text remains incremental.
type webCitationStream struct {
	pending   string
	normalize func(string) string
}

func (s *webCitationStream) feed(text string) string {
	s.pending += text
	out := ""
	for {
		start := strings.Index(s.pending, "")
		if start < 0 {
			out += s.pending
			s.pending = ""
			break
		}
		out += s.pending[:start]
		s.pending = s.pending[start:]
		end := strings.Index(s.pending, "")
		if end < 0 {
			if len(s.pending) > 8192 {
				out += s.pending
				s.pending = ""
			}
			break
		}
		end += len("")
		out += s.normalize(s.pending[:end])
		s.pending = s.pending[end:]
	}
	return out
}
func (s *webCitationStream) finish() string {
	out := s.normalize(s.pending)
	s.pending = ""
	return out
}
