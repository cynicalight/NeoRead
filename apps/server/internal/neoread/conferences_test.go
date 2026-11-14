package neoread

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"neoread.local/server/internal/diagnostics"
)

func TestConferenceRankEndpointNormalizesAliasesAndBypassesLegacyCache(t *testing.T) {
	groups := []struct {
		abbreviation string
		aliases      []string
	}{
		{"NeurIPS", []string{"Neural Information Processing Systems", "Advances in Neural Information Processing Systems 36", "NIPS", "NeurIPS 2023"}},
		{"ICLR", []string{"International Conference on Learning Representations", "International Conference on Learning Representations (ICLR) 2022", "ICLR 2022"}},
		{"NAACL", []string{"Proceedings of the 2019 Conference of the North American Chapter of the Association for Computational Linguistics: Human Language Technologies, Volume 1 (Long and Short Papers)", "NAACL"}},
		{"ICML", []string{"Proceedings of the 40th International Conference on Machine Learning", "International Conference on Machine Learning 2023", "ICML"}},
	}
	var mu sync.Mutex
	var queried []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		queried = append(queried, r.URL.Query().Get("publicationName"))
		mu.Unlock()
		_, _ = w.Write([]byte(`{"code":200,"msg":"SUCCESS","data":{"officialRank":{"all":{"sci":"Q1"}}}}`))
	}))
	defer upstream.Close()
	previous := journalRankURL
	journalRankURL = upstream.URL
	defer func() { journalRankURL = previous }()
	s := testServer(t)
	logs, err := diagnostics.New(filepath.Join(s.Store.Root, "logs"), "conference-test")
	if err != nil {
		t.Fatal(err)
	}
	s.SetDiagnostics(logs)
	if w := request(t, s, "PUT", "/api/journal-ranks/config", strings.NewReader(`{"enabled":true,"selected":["sci"],"key":"conference-private-key"}`)); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	for groupIndex, group := range groups {
		// Both stale negatives and successful-but-incomplete EI entries existed
		// under raw aliases and the old unversioned abbreviation key.
		legacyNames := append([]string{group.abbreviation}, group.aliases...)
		for i, alias := range legacyNames {
			body := `{"status":"notFound","badges":[]}`
			if i%2 == 0 {
				body = `{"status":"found","badges":[{"key":"ei","name":"EI","value":"EI"}]}`
			}
			if _, err := s.Store.DB.Exec("INSERT OR REPLACE INTO journal_rank_cache(name,key_hash,body,checked_at) VALUES(?,?,?,?)", journalName(alias), journalKeyHash("conference-private-key"), body, now()); err != nil {
				t.Fatal(err)
			}
		}
		for aliasIndex, alias := range group.aliases {
			id := fmt.Sprintf("conference-%d-%d", groupIndex, aliasIndex)
			metadata, _ := json.Marshal(map[string]string{"itemType": "conference", "venue": alias})
			if _, err := s.Store.DB.Exec("INSERT INTO documents(id,type,title,author,size,created_at,last_opened_at,library,metadata) VALUES(?,?,?,?,?,?,?,?,?)", id, "pdf", id, "", 1, now(), now(), "papers", string(metadata)); err != nil {
				t.Fatal(err)
			}
			w := request(t, s, "GET", "/api/documents/"+id+"/journal-rank", nil)
			var result journalRankResult
			if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || result.Status != "found" || len(result.Badges) != 1 || result.Badges[0].Key != "sci" {
				t.Fatalf("%q: %d %s", alias, w.Code, w.Body.String())
			}
			doc, err := s.Store.Document(id)
			if err != nil || doc.Metadata.Venue != alias {
				t.Fatalf("metadata changed: %+v, %v", doc.Metadata, err)
			}
		}
		mu.Lock()
		if len(queried) != groupIndex+1 || queried[groupIndex] != group.abbreviation {
			t.Fatalf("upstream names: %q", queried)
		}
		mu.Unlock()
		if cached, ok := s.cachedJournalRank("conference-v1:"+strings.ToLower(group.abbreviation), journalKeyHash("conference-private-key"), false); !ok || cached.Status != "found" {
			t.Fatalf("canonical cache missing: %+v %v", cached, ok)
		}
	}
	for i, venue := range []string{"Private Journal of Original Research", "ICLR 2022 Workshop", "Advances in Neural Information Processing Systems 36 Workshops"} {
		id := fmt.Sprintf("unchanged-%d", i)
		metadata, _ := json.Marshal(map[string]string{"itemType": "journal", "venue": venue})
		if _, err := s.Store.DB.Exec("INSERT INTO documents(id,type,title,author,size,created_at,last_opened_at,library,metadata) VALUES(?,?,?,?,?,?,?,?,?)", id, "pdf", id, "", 1, now(), now(), "papers", string(metadata)); err != nil {
			t.Fatal(err)
		}
		for range 2 {
			if w := request(t, s, "GET", "/api/documents/"+id+"/journal-rank", nil); w.Code != 200 {
				t.Fatal(w.Body.String())
			}
		}
		mu.Lock()
		if len(queried) != len(groups)+i+1 || queried[len(groups)+i] != venue {
			t.Fatalf("unknown venue changed or uncached: %q", queried)
		}
		mu.Unlock()
	}
	entries, err := os.ReadDir(logs.Dir)
	if err != nil {
		t.Fatal(err)
	}
	var all strings.Builder
	for _, entry := range entries {
		data, err := os.ReadFile(filepath.Join(logs.Dir, entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		all.Write(data)
	}
	for _, field := range []string{`"event":"journal_rank.query"`, `"knownConference":true`, `"knownConference":false`, `"cacheHit":true`, `"cacheHit":false`, `"queryStatus":"found"`} {
		if !strings.Contains(all.String(), field) {
			t.Fatalf("missing diagnostic %s", field)
		}
	}
	for _, private := range []string{"conference-private-key", "Private Journal of Original Research", "Neural Information Processing Systems", upstream.URL} {
		if strings.Contains(all.String(), private) {
			t.Fatalf("diagnostics leaked %q", private)
		}
	}
}

func TestConferenceMatcherOnlyTrustsMainConferenceNames(t *testing.T) {
	cases := []struct{ venue, abbreviation string }{
		{"  NEURAL   Information Processing Systems ", "NeurIPS"},
		{"NIPS 2017", "NeurIPS"},
		{"Proceedings of the 37th International Conference on Machine Learning", "ICML"},
		{"International Joint Conference on Artificial Intelligence", "IJCAI"},
		{"Proceedings of the AAAI Conference on Artificial Intelligence", "AAAI"},
		{"Annual Meeting of the Association for Computational Linguistics", "ACL"},
		{"Conference on Empirical Methods in Natural Language Processing", "EMNLP"},
		{"IEEE/CVF Conference on Computer Vision and Pattern Recognition", "CVPR"},
		{"IEEE International Conference on Computer Vision", "ICCV"},
		{"European Conference on Computer Vision", "ECCV"},
		{"ICLR Workshop", ""},
		{"Proceedings of the AAAI Conference on Artificial Intelligence Workshops", ""},
		{"NAACL 2019: Demonstrations", ""},
		{"Workshop on Neural Information Processing Systems", ""},
		{"Not ICML", ""},
		{"Journal of Machine Learning Research", ""},
	}
	for _, tc := range cases {
		conference, ok := matchConference(tc.venue)
		if ok != (tc.abbreviation != "") || conference.Abbreviation != tc.abbreviation {
			t.Errorf("%q: %+v %v", tc.venue, conference, ok)
		}
	}
}

func TestConferenceRankEndpointSharesConcurrentAliases(t *testing.T) {
	var mu sync.Mutex
	var names []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		names = append(names, r.URL.Query().Get("publicationName"))
		mu.Unlock()
		_, _ = w.Write([]byte(`{"code":200,"msg":"SUCCESS","data":{"officialRank":{"all":null}}}`))
	}))
	defer upstream.Close()
	previous := journalRankURL
	journalRankURL = upstream.URL
	defer func() { journalRankURL = previous }()
	s := testServer(t)
	if w := request(t, s, "PUT", "/api/journal-ranks/config", strings.NewReader(`{"enabled":true,"selected":["sci"],"key":"test-key"}`)); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	for i, alias := range []string{"NIPS", "NeurIPS", "Advances in Neural Information Processing Systems 36"} {
		metadata, _ := json.Marshal(map[string]string{"itemType": "conference", "venue": alias})
		if _, err := s.Store.DB.Exec("INSERT INTO documents(id,type,title,author,size,created_at,last_opened_at,library,metadata) VALUES(?,?,?,?,?,?,?,?,?)", fmt.Sprintf("shared-%d", i), "pdf", "Shared conference", "", 1, now(), now(), "papers", string(metadata)); err != nil {
			t.Fatal(err)
		}
	}
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := range 3 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			w := request(t, s, "GET", fmt.Sprintf("/api/documents/shared-%d/journal-rank", i), nil)
			if w.Code != 200 || !strings.Contains(w.Body.String(), `"status":"notFound"`) {
				t.Errorf("shared alias: %d %s", w.Code, w.Body.String())
			}
		}()
	}
	close(start)
	wg.Wait()
	mu.Lock()
	defer mu.Unlock()
	if len(names) != 1 || names[0] != "NeurIPS" {
		t.Fatalf("concurrent aliases queried separately: %q", names)
	}
}

func TestConferenceRankFailureDiagnosticsDoNotExposeVenue(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer upstream.Close()
	previous := journalRankURL
	journalRankURL = upstream.URL
	defer func() { journalRankURL = previous }()
	s := testServer(t)
	logs, err := diagnostics.New(filepath.Join(s.Store.Root, "logs"), "conference-failure")
	if err != nil {
		t.Fatal(err)
	}
	s.SetDiagnostics(logs)
	if w := request(t, s, "PUT", "/api/journal-ranks/config", strings.NewReader(`{"enabled":true,"selected":["sci"],"key":"failure-private-key"}`)); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if _, err := s.Store.DB.Exec("INSERT INTO documents(id,type,title,author,size,created_at,last_opened_at,library,metadata) VALUES(?,?,?,?,?,?,?,?,?)", "failed-conference", "pdf", "Failed conference", "", 1, now(), now(), "papers", `{"itemType":"conference","venue":"Neural Information Processing Systems"}`); err != nil {
		t.Fatal(err)
	}
	w := request(t, s, "GET", "/api/documents/failed-conference/journal-rank", nil)
	if w.Code != 502 {
		t.Fatalf("upstream failure: %d %s", w.Code, w.Body.String())
	}
	entries, err := os.ReadDir(logs.Dir)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, entry := range entries {
		data, err := os.ReadFile(filepath.Join(logs.Dir, entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		for _, line := range strings.Split(string(data), "\n") {
			if !strings.Contains(line, `"event":"journal_rank.query"`) {
				continue
			}
			found = true
			for _, field := range []string{`"queryStatus":"error"`, `"knownConference":true`, `"cacheHit":false`, w.Header().Get("X-NeoRead-Request-ID")} {
				if !strings.Contains(line, field) {
					t.Fatalf("missing failure diagnostic %s", field)
				}
			}
			for _, private := range []string{"failure-private-key", "Neural Information Processing Systems", upstream.URL} {
				if strings.Contains(line, private) {
					t.Fatalf("failure diagnostic leaked %q", private)
				}
			}
		}
	}
	if !found {
		t.Fatal("missing query failure event")
	}
}
