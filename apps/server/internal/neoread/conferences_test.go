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
		conference, ok := matchConference(group.abbreviation)
		if !ok {
			t.Fatalf("conference not recognized: %s", group.abbreviation)
		}
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
		if len(queried) != groupIndex+1 || queried[groupIndex] != conference.FullName {
			t.Fatalf("upstream names: %q", queried)
		}
		mu.Unlock()
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
	if len(names) != 2 || names[0] != "Conference on Neural Information Processing Systems" || names[1] != "NeurIPS" {
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

// Conference-only identity manifests transcribed from the CCF seventh edition
// (2026-03-31, corrected April 9). No recommendation levels are stored here.
func TestConferenceCatalogCoversEveryCCFDomain(t *testing.T) {
	domains := map[string]string{
		"architecture":       "PPoPP|FAST|DAC|HPCA|MICRO|SC|ASPLOS|ISCA|ACM SIGOPS ATC|EuroSys|HPDC|SoCC|SPAA|PODC|FPGA|CGO|DATE|HOT CHIPS|CLUSTER|ICCD|ICCAD|ICDCS|CODES+ISSS|HiPEAC|SIGMETRICS|PACT|ICPP|ICS|VEE|IPDPS|Performance|ITC|LISA|MSST|RTAS|Euro-Par|ISCAS|CF|SYSTOR|NOCS|ASAP|ASP-DAC|ETS|FPL|FCCM|GLSVLSI|ATS|HPCC|HiPC|MASCOTS|ISPA|CCGRID|NPC|ICA3PP|CASES|FPT|ICPADS|ISLPED|ISPD|HOTI|VTS|ITC-Asia|SEC|NAS|HotStorage|APPT|JCC",
		"networks":           "SIGCOMM|MobiCom|INFOCOM|NSDI|SenSys|CoNEXT|SECON|IPSN|MobiSys|ICNP|MobiHoc|NOSSDAV|IWQoS|IMC|ANCS|APNOMS|FORTE|LCN|GLOBECOM|ICC|ICCCN|MASS|P2P|IPCCC|WoWMoM|ISCC|WCNC|Networking|IM|MSN|MSWiM|WASA|HotNets|APNet",
		"security":           "CCS|EUROCRYPT|S&P|CRYPTO|USENIX Security|NDSS|ACSAC|ASIACRYPT|ESORICS|FSE|CSFW|SRDS|CHES|DSN|RAID|PKC|TCC|WiSec|SACMAT|DRM|IH&MMSec|ACNS|AsiaCCS|ACISP|CT-RSA|DIMVA|DFRWS|FC|TrustCom|SEC|IFIP WG 11.9|ISC|ICDF2C|ICICS|SecureComm|NSPW|PAM|PETS|SAC|SOUPS|HotSec|EuroS&P|Inscrypt|CODASPY|BlockSys|CSCloud",
		"software":           "PLDI|POPL|FSE|SOSP|OOPSLA|ASE|ICSE|ISSTA|OSDI|FM|ECOOP|ETAPS|ICPC|RE|CAiSE|ICFP|LCTES|MoDELS|CP|ICSOC|SANER|ICSME|VMCAI|ICWS|Middleware|SAS|ESEM|ISSRE|HotOS|CC|PEPM|PASTE|APLAS|APSEC|EASE|ICECCS|ICST|ISPASS|SCAM|COMPSAC|ICFEM|SSE|ICSSP|SEKE|QRS|ICSR|ICWE|SPIN|ATVA|LOPSTR|TASE|MSR|REFSQ|WICSA|Internetware|RV|MEMOCODE",
		"databases":          "SIGMOD|SIGKDD|ICDE|SIGIR|VLDB|CIKM|WSDM|PODS|DASFAA|ECML-PKDD|ISWC|ICDM|ICDT|EDBT|CIDR|SDM|RecSys|WISE|APWeb|DEXA|ECIR|ESWC|WebDB|ER|MDM|SSDBM|WAIM|SSTD|PAKDD|ADMA|WISA",
		"theory":             "STOC|SODA|CAV|FOCS|LICS|SoCG|ESA|CCC|ICALP|CADE|CONCUR|HSCC|SAT|COCOON|FMCAD|CSL|FSTTCS|DSAA|ICTAC|IPCO|FSCD|ISAAC|MFCS|STACS|SETTA",
		"graphics":           "ACM MM|SIGGRAPH|VR|IEEE VIS|ICMR|I3D|SCA|DCC|Eurographics|EuroVis|SGP|EGSR|ICASSP|ICME|ISMAR|PG|SPM|INTERSPEECH|VRST|CASAXR|CGI|GMP|PacificVis|3DV|CAD/Graphics|ICIP|MMM|MMAsia|SMI|CVM|PRCV|ICIG|NCMMSC|ASRU|SLT",
		"ai":                 "AAAI|NeurIPS|ACL|CVPR|ICCV|ICML|ICLR|COLT|EMNLP|ECAI|ECCV|ICRA|ICAPS|ICCBR|COLING|KR|UAI|AAMAS|PPSN|NAACL|IJCAI|AISTATS|ACCV|ACML|BMVC|NLPCC|CoNLL|GECCO|ICTAI|IROS|ALT|ICANN|FG|ICDAR|ILP|KSEM|ICONIP|ICPR|IJCB|IJCNN|PRICAI|IEEE CEC|DAI",
		"hci":                "CSCW|CHI|UbiComp|UIST|GROUP|IUI|ISS|ECSCW|PERCOM|MobileHCI|ICWSM|DIS|ICMI|ASSETS|GI|UIC|IEEE World Haptics Conference|INTERACT|IDC|CollaborateCom|CSCWD|CoopIS|MobiQuitous|AVI|GPC|ICXR",
		"cross-disciplinary": "WWW|RTSS|CogSci|BIBM|EMSOFT|ISMB|RECOMB|MICCAI|WINE|AMIA|APBC|IEEE BigData|IEEE CLOUD|SMC|COSIT|ISBRA|SAGT|SIGSPATIAL|ICIC|ICSS|AFT|IJTCS-FAW",
	}
	identities := make(map[string]int)
	for _, entry := range conferenceCatalog {
		identities[entry.Abbreviation]++
		identities[entry.FullName]++
		for _, alias := range entry.Aliases {
			identities[alias]++
		}
	}
	for domain, names := range domains {
		for _, name := range strings.Split(names, "|") {
			if identities[name] == 0 {
				t.Errorf("%s is missing CCF conference %q", domain, name)
			}
		}
	}
}

func TestConferenceCatalogCanonicalNamesRoundTrip(t *testing.T) {
	for _, entry := range conferenceCatalog {
		t.Run(entry.FullName, func(t *testing.T) {
			actual, ok := matchConference(entry.FullName)
			if !ok || actual.FullName != entry.FullName || actual.Abbreviation != entry.Abbreviation {
				t.Errorf("canonical name did not round-trip: %+v %v", actual, ok)
			}
		})
	}
}

func TestConferenceWrappersDomainsAndEngineering(t *testing.T) {
	cases := []struct{ venue, abbreviation string }{
		{"Proceedings of the 2026 ACM SIGSAC Conference on Computer and Communications Security", "CCS"},
		{"USENIX Annual Technical Conference", "USENIX ATC"},
		{"Proceedings of the 20th USENIX Symposium on Operating Systems Design and Implementation", "OSDI"},
		{"Proceedings of the 2019 Conference of the North American Chapter of the Association for Computational Linguistics: Human Language Technologies, Volume 1 (Long and Short Papers)", "NAACL"},
		{"Advances in Neural Information Processing Systems 36 (NeurIPS 2023)", "NeurIPS"},
		{"Advances in Neural Information Processing Systems 30 (NIPS 2017)", "NeurIPS"},
		{"2024 IEEE International Conference on Communications (ICC)", "ICC"},
		{"2025 IEEE/ACM International Conference on Software Engineering (ICSE)", "ICSE"},
		{"Proceedings of the 2024 ACM SIGMOD International Conference on Management of Data", "SIGMOD"},
		{"ACM Symposium on Theory of Computing", "STOC"},
		{"ACM International Conference on Multimedia", "ACM MM"},
		{"ACM Conference on Human Factors in Computing Systems", "CHI"},
		{"The Web Conference 2026", "WWW"},
		{"IEEE International Conference on Acoustics, Speech, and Signal Processing", "ICASSP"},
		{"IEEE International Conference on Image Processing", "ICIP"},
		{"IEEE Global Communications Conference", "GLOBECOM"},
		{"IEEE Conference on Decision and Control", "CDC"},
		{"American Control Conference", "ACC"},
		{"IEEE International Conference on Robotics and Automation", "ICRA"},
		{"IEEE/RSJ International Conference on Intelligent Robots and Systems", "IROS"},
		{"International Conference on Automated Planning and Scheduling", "ICAPS"},
		{"International Conference on Computer-Aided Design", "ICCAD"},
		{"Design, Automation & Test in Europe", "DATE"},
		{"Design Automation Conference", "DAC"},
		{"IEEE International Solid-State Circuits Conference", "ISSCC"},
		{"IEEE International Electron Devices Meeting", "IEDM"},
		{"IEEE Applied Power Electronics Conference and Exposition", "APEC"},
		{"IEEE Energy Conversion Congress and Exposition", "ECCE"},
		{"IEEE Power & Energy Society General Meeting", "PES GM"},
		{"IEEE International Conference on Intelligent Transportation Systems", "ITSC"},
		{" IEEE\u00a0 International   Conference on Communications ", "ICC"},
		{"USENIX Workshop on Hot Topics in Operating Systems", "HotOS"},
		{"ACM Workshop on Hot Topics in Networks", "HotNets"},
		{"Fast Software Encryption", "FSE"},
		{"ACM International Conference on the Foundations of Software Engineering", "FSE"},
		{"IFIP International Information Security Conference", "SEC"},
		{"ACM/IEEE Symposium on Edge Computing", "SEC"},
	}
	for _, tc := range cases {
		if entry, ok := matchConference(tc.venue); !ok || entry.Abbreviation != tc.abbreviation {
			t.Errorf("%q: got %+v %v, want %s", tc.venue, entry, ok, tc.abbreviation)
		}
	}
	for _, venue := range []string{
		"FSE", "SEC", "ISWC", "FSE 2026",
		"Findings of the Association for Computational Linguistics: ACL 2024",
		"Proceedings of the ACM SIGSAC Conference on Computer and Communications Security Workshops",
		"Proceedings of the ACL: System Demonstrations",
		"ICML Demo", "ICC Workshops", "ICASSP Workshops",
		"Proceedings of the IEEE/CVF Conference on Computer Vision and Pattern Recognition Workshops",
		"International Conference on Machine Learning Applications",
		"International Conference on Communications and Computing",
		"Pattern Recognition", "IEEE Transactions on Computers",
	} {
		if entry, ok := matchConference(venue); ok {
			t.Errorf("ambiguous or non-main venue %q matched %+v", venue, entry)
		}
	}
}
