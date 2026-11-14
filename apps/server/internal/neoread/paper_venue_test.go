package neoread

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func venueTestDocument(t *testing.T, s *Server, metadata PaperMetadata) Document {
	t.Helper()
	id := id()
	_, err := s.Store.DB.Exec("INSERT INTO documents(id,type,title,author,size,created_at,last_opened_at,library,metadata) VALUES(?,?,?,?,?,?,?,?,?)", id, "pdf", "A Reliable Paper Title", "", 1, now(), now(), "papers", jsonText(metadata))
	if err != nil {
		t.Fatal(err)
	}
	d, err := s.Store.Document(id)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

// Exercise the actual taskChat adapter, PI completion protocol and Go web tools,
// not a generation stub that merely returns the expected venue strings.
func TestPaperVenueFinalFallbackWorkflow(t *testing.T) {
	piTestRuntime(t)
	for _, tc := range []struct {
		name                                                          string
		metadata                                                      PaperMetadata
		reply                                                         string
		noSearch, manualRace, canceled, incomplete, resolve, apiVenue bool
		wantVenue, wantShort                                          string
		wantWeb                                                       int
	}{
		{name: "identifier lookup without venue", reply: `{"fullName":"Example Proceedings","shortName":"EP"}`, wantVenue: "Example Proceedings", wantShort: "EP", wantWeb: 2},
		{name: "online arxiv import", resolve: true, reply: `{"fullName":"Example Proceedings","shortName":"EP"}`, wantVenue: "Example Proceedings", wantShort: "EP", wantWeb: 2},
		{name: "API venue skips Agent", apiVenue: true, wantVenue: "Published Journal 12 (2024) 1-8"},
		{name: "online API venue skips Agent", resolve: true, apiVenue: true, wantVenue: "Published Journal 12 (2024) 1-8"},
		{name: "known existing venue", metadata: PaperMetadata{Venue: "NeurIPS"}, wantVenue: "NeurIPS"},
		{name: "unknown existing venue", metadata: PaperMetadata{Venue: "Unlisted Conference"}, wantVenue: "Unlisted Conference"},
		{name: "previously cleared venue", metadata: PaperMetadata{Sources: map[string]string{"venue": "manual"}}, reply: `{"fullName":"Example Proceedings","shortName":"EP"}`, wantVenue: "Example Proceedings", wantShort: "EP", wantWeb: 2},
		{name: "no configured search", noSearch: true},
		{name: "full name without known abbreviation", reply: `{"fullName":"Example Journal","shortName":""}`, wantVenue: "Example Journal", wantWeb: 2},
		{name: "empty unknown", reply: `{"fullName":"","shortName":""}`, wantWeb: 2},
		{name: "extra field rejected", reply: `{"fullName":"Example","shortName":"E","year":2026}`, wantWeb: 2},
		{name: "duplicate field rejected", reply: `{"fullName":"Example","shortName":"E","shortName":"Other"}`, wantWeb: 2},
		{name: "null rejected", reply: `{"fullName":"Example","shortName":null}`, wantWeb: 2},
		{name: "bad JSON", reply: "not JSON", wantWeb: 2},
		{name: "incomplete completion", reply: `{"fullName":"Example","shortName":"E"}`, incomplete: true, wantWeb: 2},
		{name: "lookup completes after editing", reply: `{"fullName":"Example","shortName":"E"}`, manualRace: true, wantVenue: "Example", wantShort: "E", wantWeb: 2},
		{name: "canceled", canceled: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := testServer(t)
			scholarFixture(t, s)
			if tc.apiVenue {
				api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					_, _ = w.Write([]byte(strings.Replace(lookupAtom, "</entry>", `<journal_ref xmlns="http://arxiv.org/schemas/atom">Published Journal 12 (2024) 1-8</journal_ref></entry>`, 1)))
				}))
				t.Cleanup(api.Close)
				s.scholar.ArXivAPI = api.URL
			}
			upstream, calls := fakeAPI(t, func(int, apiCall) string {
				t.Error("unexpected direct completion/title extraction")
				return "unexpected"
			})
			config := AIConfig{Primary: "api", API: APIConnection{URL: upstream.URL + "/v1", Key: "sk-test"}, Models: map[string]string{"api": "plain"}}
			passModels(&config, map[string]bool{"plain": false})
			cap := config.Capabilities[apiCapabilityKey("plain")]
			cap.Tools, cap.ToolSchemaVersion = "passed", documentToolSchemaVersion
			config.Capabilities[apiCapabilityKey("plain")] = cap
			if !tc.noSearch {
				config.WebSearch = &WebSearchConfig{Provider: "deepseek", URL: "https://search.example", Key: "search-secret"}
			}
			if err := s.writeAIConfig(config); err != nil {
				t.Fatal(err)
			}
			metadata := tc.metadata
			metadata.ArXiv = "1706.03762"
			metadata.Abstract = "PRIVATE-ABSTRACT"
			metadata.Remark = "PRIVATE-NOTE"
			d := venueTestDocument(t, s, metadata)
			reply := tc.reply
			if reply == "" {
				reply = `{"fullName":"Wrong","shortName":"W"}`
			}
			finish := "stop"
			if tc.incomplete {
				finish = "length"
			}
			preload := filepath.Join(t.TempDir(), "model.cjs")
			script := `globalThis.fetch=async function(url,init){
 const p=JSON.parse(init.body), tools=p.messages.filter(m=>m.role==='tool');
 if(!p.messages.some(m=>m.role==='system'&&JSON.stringify(m.content).includes('Identify the formal journal')))throw new Error('internal system prompt lost');
 if(init.body.includes('search-secret')||init.body.includes('PRIVATE-ABSTRACT')||init.body.includes('PRIVATE-NOTE'))throw new Error('private data leaked');
 if(!p.tools?.some(t=>t.function.name==='web_search'))throw new Error('missing web tools');
 const call=tools.length===0?{name:'web_search',arguments:JSON.stringify({query:'A Reliable Paper Title'})}:tools.length===1?{name:'web_fetch',arguments:JSON.stringify({url:'https://1.1.1.1/paper'})}:null;
 const delta=call?{tool_calls:[{index:0,id:'tool-'+tools.length,type:'function',function:call}]}:{content:` + jsonText(reply) + `};
 let out='';for(const choice of [{delta,finish_reason:null},{delta:{},finish_reason:call?'tool_calls':` + jsonText(finish) + `}])out+='data: '+JSON.stringify({id:'test',object:'chat.completion.chunk',model:'plain',choices:[{index:0,...choice}]})+'\n\n';
 return new Response(out+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
};`
			if err := os.WriteFile(preload, []byte(script), 0600); err != nil {
				t.Fatal(err)
			}
			t.Setenv("NODE_OPTIONS", "--require="+preload)
			oldTransport := http.DefaultTransport
			webCalls := 0
			http.DefaultTransport = webRoundTrip(func(r *http.Request) (*http.Response, error) {
				if r.URL.Host != "search.example" {
					return oldTransport.RoundTrip(r)
				}
				webCalls++
				if tc.manualRace && webCalls == 1 {
					w := request(t, s, "PATCH", "/api/documents/"+d.ID, strings.NewReader(`{"metadata":{"venue":"User Journal"}}`))
					if w.Code != 200 {
						t.Error(w.Body.String())
					}
				}
				if strings.HasSuffix(r.URL.Path, "search") {
					return webJSON(200, `{"results":[{"url":"https://1.1.1.1/paper","title":"Official proceedings","summary":"Example Proceedings"}]}`), nil
				}
				return webJSON(200, `{"title":"Official proceedings","content":"A Reliable Paper Title appears in Example Proceedings (EP)."}`), nil
			})
			t.Cleanup(func() { http.DefaultTransport = oldTransport })
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			if tc.canceled {
				cancel()
			}
			var got Document
			var err error
			if tc.resolve {
				w := request(t, s, "POST", "/api/documents/resolve", strings.NewReader(`{"ref":"arXiv:1706.03762"}`))
				if w.Code != 201 || json.Unmarshal(w.Body.Bytes(), &got) != nil {
					t.Fatal(w.Code, w.Body.String())
				}
				d = got
				if got.Metadata.Lookup != "pending" {
					t.Fatalf("link import did not queue the shared lookup: %+v", got.Metadata)
				}
				got, err = s.lookupDocument(ctx, got.ID, false)
			} else {
				got, err = s.lookupDocument(ctx, d.ID, false)
			}
			if !tc.canceled && err != nil {
				t.Fatal(err)
			}
			if tc.canceled && err != nil && !errors.Is(err, context.Canceled) {
				t.Fatal(err)
			}
			if got.Metadata.Venue != tc.wantVenue || got.Metadata.VenueShort != tc.wantShort || webCalls != tc.wantWeb || len(calls()) != 0 {
				t.Fatalf("venue=%q short=%q web=%d direct=%d err=%v", got.Metadata.Venue, got.Metadata.VenueShort, webCalls, len(calls()), err)
			}
			saved, saveErr := s.Store.Document(d.ID)
			if saveErr != nil || saved.Metadata.Venue != tc.wantVenue || saved.Metadata.VenueShort != tc.wantShort {
				t.Fatal(saved.Metadata, saveErr)
			}
			if tc.resolve {
				w := request(t, s, "PATCH", "/api/documents/"+d.ID, strings.NewReader(`{"metadata":{"venue":"User Journal"}}`))
				if w.Code != 200 {
					t.Fatal(w.Body.String())
				}
				w = request(t, s, "POST", "/api/documents/resolve", strings.NewReader(`{"ref":"arXiv:1706.03762"}`))
				var reimported Document
				if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &reimported) != nil || reimported.Metadata.Lookup != "pending" {
					t.Fatal(w.Code, w.Body.String())
				}
				reimported, err = s.lookupDocument(ctx, reimported.ID, false)
				wantVenue := "User Journal"
				if tc.apiVenue {
					wantVenue = tc.wantVenue
				}
				if err != nil || reimported.Metadata.Venue != wantVenue || reimported.Metadata.VenueShort != "" || webCalls != tc.wantWeb {
					t.Fatal(reimported.Metadata, err, webCalls)
				}
			}
		})
	}
}

func TestVenueShortManualValidationAndInvalidation(t *testing.T) {
	for range 20 {
		m := PaperMetadata{Venue: "Old Venue", VenueShort: "OLD"}
		if err := m.ApplyManual(map[string]json.RawMessage{"venue": json.RawMessage(`"New Venue"`), "venueShort": json.RawMessage(`"NEW"`)}); err != nil || m.VenueShort != "NEW" {
			t.Fatal(m, err)
		}
		if err := m.ApplyManual(map[string]json.RawMessage{"venue": json.RawMessage(`"Another Venue"`)}); err != nil || m.VenueShort != "" {
			t.Fatal(m, err)
		}
		if err := m.ApplyManual(map[string]json.RawMessage{"venueShort": json.RawMessage(`123`)}); err == nil {
			t.Fatal("accepted numeric abbreviation")
		}
	}
	m := PaperMetadata{Venue: "Automatic Venue", VenueShort: "OLD"}
	m.Merge(PaperMetadata{Venue: "Automatic Venue", VenueShort: "NEW"}, "lookup")
	if m.VenueShort != "NEW" {
		t.Fatal(m)
	}
	m.Merge(PaperMetadata{Venue: "Automatic Venue"}, "lookup")
	if m.VenueShort != "NEW" {
		t.Fatal("refreshing the same venue discarded its resolved abbreviation", m)
	}
	m.VenueShort = "OLD"
	m.Merge(PaperMetadata{Venue: "Other Venue"}, "lookup")
	if m.VenueShort != "" {
		t.Fatal(m)
	}
}

func TestVenueLookupReplacesManualValues(t *testing.T) {
	for _, tc := range []struct {
		name, venue, manual, source string
		found                       PaperMetadata
	}{
		{"same venue with automatic abbreviation", "Original Venue", "USER", "lookup", PaperMetadata{Venue: "Original Venue", VenueShort: "AUTO"}},
		{"changed venue without abbreviation", "Original Venue", "USER", "lookup", PaperMetadata{Venue: "Published Venue"}},
		{"changed venue with abbreviation", "Original Venue", "USER", "lookup", PaperMetadata{Venue: "Published Venue", VenueShort: "AUTO"}},
		{"manually cleared abbreviation", "Original Venue", "", "lookup", PaperMetadata{Venue: "Original Venue", VenueShort: "AUTO"}},
		{"Agent fills cleared venue and abbreviation", "", "", "venue-agent", PaperMetadata{Venue: "Published Venue", VenueShort: "AUTO"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := PaperMetadata{Venue: tc.venue}
			if err := m.ApplyManual(map[string]json.RawMessage{"venue": json.RawMessage(jsonText(tc.venue)), "venueShort": json.RawMessage(jsonText(tc.manual))}); err != nil {
				t.Fatal(err)
			}
			m.Merge(tc.found, tc.source)
			if m.Venue != tc.found.Venue || m.VenueShort != tc.found.VenueShort || m.Sources["venueShort"] != "lookup" || m.Sources["venue"] != "lookup" {
				t.Fatalf("lookup did not replace previous edits: %+v", m)
			}
		})
	}
}

func TestVenueAgentCanceledSaveAndLookupAfterClearing(t *testing.T) {
	s := testServer(t)
	d := venueTestDocument(t, s, PaperMetadata{})
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	_, _ = s.applyFound(d.ID, PaperMetadata{Venue: "Wrong", VenueShort: "W"}, "", "venue-agent", "", ctx)
	got, err := s.Store.Document(d.ID)
	if err != nil || got.Metadata.Venue != "" || got.Metadata.VenueShort != "" {
		t.Fatal(got, err)
	}
	if w := request(t, s, "PATCH", "/api/documents/"+d.ID, strings.NewReader(`{"metadata":{"venue":""}}`)); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	got, err = s.applyFound(d.ID, PaperMetadata{Venue: "Published Venue", VenueShort: "PV"}, "", "venue-agent", "")
	if err != nil || got.Metadata.Venue != "Published Venue" || got.Metadata.VenueShort != "PV" {
		t.Fatal(got, err)
	}
}
