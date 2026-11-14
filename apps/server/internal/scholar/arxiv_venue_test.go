package scholar

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestArxivVenueEnrichmentKeepsBasicMetadata(t *testing.T) {
	for _, tc := range []struct {
		name, journalRef, doi, crossrefVenue, s2ID, s2Venue, wantVenue string
		s2Failure                                                      bool
		wantS2                                                         int
	}{
		{name: "journal reference stays verbatim", journalRef: "Journal of Examples 12 (2025), 10-20", wantVenue: "Journal of Examples 12 (2025), 10-20"},
		{name: "published DOI before S2", doi: "10.1000/example", crossrefVenue: "Published Journal", wantVenue: "Published Journal"},
		{name: "precise S2 fallback", s2ID: "1706.03762", s2Venue: "Example Conference", wantVenue: "Example Conference", wantS2: 1},
		{name: "crossref failure still allows S2", doi: "10.1000/example", s2ID: "1706.03762v7", s2Venue: "Example Conference", wantVenue: "Example Conference", wantS2: 1},
		{name: "mismatched S2 ID ignored", s2ID: "2401.01234", s2Venue: "Wrong Conference", wantS2: 1},
		{name: "missing S2 ID ignored", s2Venue: "Wrong Conference", wantS2: 1},
		{name: "failed S2 preserves arxiv success", s2Failure: true, wantS2: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.URL.Path == "/arxiv":
					entry := strings.Replace(atom, `<arxiv:doi>10.5555/3295222.3295349</arxiv:doi>`, "", 1)
					entry = strings.Replace(entry, "</entry>", "<arxiv:journal_ref>"+tc.journalRef+"</arxiv:journal_ref><arxiv:doi>"+tc.doi+"</arxiv:doi></entry>", 1)
					_, _ = w.Write([]byte(entry))
				case strings.HasPrefix(r.URL.Path, "/crossref/"):
					if tc.crossrefVenue == "" {
						http.NotFound(w, r)
						return
					}
					_, _ = w.Write([]byte(`{"message":{"type":"journal-article","title":["Attention Is All You Need"],"container-title":["` + tc.crossrefVenue + `"]}}`))
				case strings.HasPrefix(r.URL.Path, "/s2/"):
					calls++
					if r.URL.Path != "/s2/ARXIV:1706.03762" {
						t.Errorf("not an exact identifier lookup: %s", r.URL.Path)
					}
					if tc.s2Failure {
						http.NotFound(w, r)
						return
					}
					_, _ = w.Write([]byte(`{"title":"Attention Is All You Need","venue":"` + tc.s2Venue + `","externalIds":{"ArXiv":"` + tc.s2ID + `"}}`))
				default:
					t.Errorf("unexpected query: %s", r.URL.Path)
					http.NotFound(w, r)
				}
			}))
			defer api.Close()
			c := New(1 << 20)
			c.AllowPrivateHosts = true
			c.ArXivAPI, c.Crossref, c.SemanticScholar = api.URL+"/arxiv", api.URL+"/crossref/", api.URL+"/s2/"
			m, err := c.Lookup(context.Background(), Identifiers{ArXiv: "1706.03762v7"})
			if err != nil || m.Title != "Attention Is All You Need" || m.ArXiv != "1706.03762v7" || m.Venue != tc.wantVenue || len(m.Creators) != 2 || m.Abstract == "" || calls != tc.wantS2 {
				t.Fatalf("metadata=%+v err=%v S2=%d", m, err, calls)
			}
		})
	}
}
