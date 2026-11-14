package neoread

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestJournalRankVenueNamesAreBoundedAndOrdered(t *testing.T) {
	conference, ok := matchConference("ICML")
	if !ok {
		t.Fatal("ICML missing from local catalog")
	}
	for _, tc := range []struct {
		name            string
		metadata        PaperMetadata
		firstMiss, fail bool
		want            []string
	}{
		{name: "known full name hits", metadata: PaperMetadata{Venue: conference.FullName, VenueShort: "wrong"}, want: []string{conference.FullName}},
		{name: "known abbreviation fallback", metadata: PaperMetadata{Venue: conference.FullName}, firstMiss: true, want: []string{conference.FullName, conference.Abbreviation}},
		{name: "Agent full name hits for preprint", metadata: PaperMetadata{ItemType: "preprint", Venue: "Unlisted Conference", VenueShort: "UC"}, want: []string{"Unlisted Conference"}},
		{name: "Agent abbreviation fallback", metadata: PaperMetadata{Venue: "Unlisted Conference", VenueShort: "UC"}, firstMiss: true, want: []string{"Unlisted Conference", "UC"}},
		{name: "journal unchanged", metadata: PaperMetadata{ItemType: "journal", Venue: "Example Journal"}, want: []string{"Example Journal"}},
		{name: "identical names deduplicated", metadata: PaperMetadata{Venue: "UC", VenueShort: "uc"}, firstMiss: true, want: []string{"UC"}},
		{name: "failure not an alias retry", metadata: PaperMetadata{Venue: conference.FullName}, fail: true, want: []string{conference.FullName}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := testServer(t)
			d := venueTestDocument(t, s, tc.metadata)
			queries := []string{}
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				queries = append(queries, r.URL.Query().Get("publicationName"))
				if tc.fail {
					w.WriteHeader(http.StatusUnauthorized)
					return
				}
				if tc.firstMiss && len(queries) == 1 {
					_, _ = w.Write([]byte(`{"code":200,"data":{"officialRank":{"all":{}}}}`))
					return
				}
				_, _ = w.Write([]byte(`{"code":200,"data":{"officialRank":{"all":{"ccf":"A"}}}}`))
			}))
			defer upstream.Close()
			old := journalRankURL
			journalRankURL = upstream.URL
			defer func() { journalRankURL = old }()
			w := request(t, s, "PUT", "/api/journal-ranks/config", strings.NewReader(`{"enabled":true,"selected":["ccf"],"key":"test-key"}`))
			if w.Code != 200 {
				t.Fatal(w.Body.String())
			}
			if tc.metadata.Venue == conference.FullName {
				// Both the raw-name negative cache and the old partial conference
				// cache must be bypassed by the new bounded-name strategy.
				for _, name := range []string{journalName(conference.FullName), "conference-v1:" + journalName(conference.Abbreviation)} {
					_, err := s.Store.DB.Exec("INSERT INTO journal_rank_cache(name,key_hash,body,checked_at) VALUES(?,?,?,?)", name, journalKeyHash("test-key"), jsonText(journalRankResult{Status: "found", Badges: []journalRankBadge{{Key: "eii", Value: "old"}}, CheckedAt: now()}), now())
					if err != nil {
						t.Fatal(err)
					}
				}
			}
			w = request(t, s, "GET", "/api/documents/"+d.ID+"/journal-rank", nil)
			if tc.fail {
				if w.Code != 502 {
					t.Fatal(w.Code, w.Body.String())
				}
			} else if w.Code != 200 {
				t.Fatal(w.Code, w.Body.String())
			}
			if jsonText(queries) != jsonText(tc.want) {
				t.Fatalf("queries=%v want=%v", queries, tc.want)
			}
			if !tc.fail {
				var result journalRankResult
				if json.Unmarshal(w.Body.Bytes(), &result) != nil {
					t.Fatal(w.Body.String())
				}
				wantStatus := "found"
				if tc.firstMiss && len(tc.want) == 1 {
					wantStatus = "notFound"
				}
				if result.Status != wantStatus {
					t.Fatalf("status=%s want=%s", result.Status, wantStatus)
				}
				if result.Status == "found" && (len(result.Badges) != 1 || result.Badges[0].Key != "ccf") {
					t.Fatal(result)
				}
				w = request(t, s, "GET", "/api/documents/"+d.ID+"/journal-rank", nil)
				if w.Code != 200 || len(queries) != len(tc.want) {
					t.Fatal("bounded result was not cached", queries)
				}
			}
		})
	}
}

func TestJournalRankShortChangesDoNotReuseOldResult(t *testing.T) {
	s := testServer(t)
	d := venueTestDocument(t, s, PaperMetadata{Venue: "Unlisted Conference", VenueShort: "OLD"})
	ratings := map[string]string{"OLD": "C", "NEW": "A", "Unlisted Conference": "B"}
	queries := []string{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := r.URL.Query().Get("publicationName")
		queries = append(queries, name)
		current, err := s.Store.Document(d.ID)
		if err != nil {
			t.Error(err)
		}
		if name == "Unlisted Conference" && current.Metadata.VenueShort != "" {
			_, _ = w.Write([]byte(`{"code":200,"data":{"officialRank":{"all":{}}}}`))
			return
		}
		_, _ = w.Write([]byte(`{"code":200,"data":{"officialRank":{"all":{"ccf":` + jsonText(ratings[name]) + `}}}}`))
	}))
	defer upstream.Close()
	old := journalRankURL
	journalRankURL = upstream.URL
	defer func() { journalRankURL = old }()
	if w := request(t, s, "PUT", "/api/journal-ranks/config", strings.NewReader(`{"enabled":true,"selected":["ccf"],"key":"test-key"}`)); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	for _, short := range []string{"OLD", "NEW", ""} {
		if w := request(t, s, "PATCH", "/api/documents/"+d.ID, strings.NewReader(`{"metadata":{"venueShort":`+jsonText(short)+`}}`)); w.Code != 200 {
			t.Fatal(w.Body.String())
		}
		w := request(t, s, "GET", "/api/documents/"+d.ID+"/journal-rank", nil)
		want := short
		if want == "" {
			want = "Unlisted Conference"
		}
		var result journalRankResult
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || len(result.Badges) != 1 || result.Badges[0].Value != ratings[want] {
			t.Fatal(w.Code, w.Body.String(), queries)
		}
	}
	if jsonText(queries) != `["Unlisted Conference","OLD","Unlisted Conference","NEW","Unlisted Conference"]` {
		t.Fatal(queries)
	}
}

func TestJournalRankAmbiguousConferenceAbbreviationsStaySeparate(t *testing.T) {
	s := testServer(t)
	var documents []Document
	var fullNames []string
	for _, entry := range conferenceCatalog {
		if entry.Abbreviation == "FSE" {
			documents = append(documents, venueTestDocument(t, s, PaperMetadata{Venue: entry.FullName, VenueShort: "FSE"}))
			fullNames = append(fullNames, entry.FullName)
		}
	}
	if len(documents) < 2 {
		t.Fatal("expected distinct FSE conferences")
	}
	ratings := map[string]string{fullNames[0]: "A", fullNames[1]: "B"}
	queries := []string{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := r.URL.Query().Get("publicationName")
		queries = append(queries, name)
		if name == "FSE" {
			t.Error("queried ambiguous abbreviation")
		}
		_, _ = w.Write([]byte(`{"code":200,"data":{"officialRank":{"all":{"ccf":` + jsonText(ratings[name]) + `}}}}`))
	}))
	defer upstream.Close()
	old := journalRankURL
	journalRankURL = upstream.URL
	defer func() { journalRankURL = old }()
	if w := request(t, s, "PUT", "/api/journal-ranks/config", strings.NewReader(`{"enabled":true,"selected":["ccf"],"key":"test-key"}`)); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	for range 2 {
		for i, d := range documents {
			w := request(t, s, "GET", "/api/documents/"+d.ID+"/journal-rank", nil)
			var result journalRankResult
			if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || len(result.Badges) != 1 || result.Badges[0].Value != ratings[fullNames[i]] {
				t.Fatal(w.Code, w.Body.String(), queries)
			}
		}
	}
	if jsonText(queries) != jsonText(fullNames) {
		t.Fatalf("shared or duplicate cache queries: %v", queries)
	}
}
