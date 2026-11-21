package neoread

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func readOCRResponse(t *testing.T, s *Server, method, body string) ocrStatus {
	t.Helper()
	out := request(t, s, method, "/api/ocr", strings.NewReader(body))
	var status ocrStatus
	if out.Code != 200 || json.Unmarshal(out.Body.Bytes(), &status) != nil {
		t.Fatalf("OCR status = %d %s", out.Code, out.Body)
	}
	return status
}

func ocrFixture(t *testing.T) *Server {
	t.Helper()
	s, _ := processingFixture(t)
	s.Token = "test-secret"
	t.Cleanup(s.Close)
	return s
}

func TestOCRScanNoticePersistsAndDismisses(t *testing.T) {
	s := ocrFixture(t)
	if runtime.GOOS == "darwin" {
		worker := filepath.Join(s.Store.Root, "processor.mjs")
		t.Setenv("NEOREAD_PROCESSOR", worker)
		if err := os.WriteFile(filepath.Join(filepath.Dir(worker), "apple-ocr-helper"), []byte("helper"), 0700); err != nil {
			t.Fatal(err)
		}
	}
	initial := readOCRResponse(t, s, "GET", "")
	if initial.ModelState != "missing" || initial.TotalBytes != 89477890 || initial.DownloadedBytes != 0 || initial.Notices == nil || len(initial.Notices) != 0 {
		t.Fatalf("initial state %+v", initial)
	}
	if runtime.GOOS == "darwin" && (!initial.SystemAvailable || initial.Engine != "system") {
		t.Fatalf("system default %+v", initial)
	}
	event := layoutDiagnostic{Event: "scan", Page: 1, Total: 2}
	s.recordScan("run", "doc", event)
	s.recordScan("duplicate", "doc", event)
	reopened := NewServer(s.Store, s.Token, "")
	state := readOCRResponse(t, reopened, "GET", "")
	if len(state.Notices) != 1 || state.Notices[0].DocumentID != "doc" || state.Notices[0].Title != "test" {
		t.Fatalf("notices %+v", state.Notices)
	}
	if state = readOCRResponse(t, reopened, "POST", `{"action":"dismiss","documentId":"doc"}`); len(state.Notices) != 0 {
		t.Fatalf("dismiss left notices: %+v", state.Notices)
	}
	s.recordScan("subsequent", "doc", event)
	reopened = NewServer(s.Store, s.Token, "")
	if state = readOCRResponse(t, reopened, "GET", ""); len(state.Notices) != 0 {
		t.Fatalf("dismissed notice returned: %+v", state.Notices)
	}
	if out := request(t, s, "POST", "/api/ocr", strings.NewReader(`{"action":"use-paddle"}`)); out.Code != 409 {
		t.Fatalf("accepted uninstalled Paddle: %d %s", out.Code, out.Body)
	}
}

func TestOCREnginePreferencePersistsAndReadyHidesNotices(t *testing.T) {
	s := ocrFixture(t)
	if runtime.GOOS == "darwin" {
		worker := filepath.Join(s.Store.Root, "processor.mjs")
		t.Setenv("NEOREAD_PROCESSOR", worker)
		if err := os.WriteFile(filepath.Join(filepath.Dir(worker), "apple-ocr-helper"), []byte("helper"), 0700); err != nil {
			t.Fatal(err)
		}
	}
	s.recordScan("run", "doc", layoutDiagnostic{Event: "scan", Page: 1, Total: 2})
	dir := s.ocrModelDir()
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	// Model integrity itself is covered by the streaming install test.
	for _, artifact := range ocrArtifacts {
		path := filepath.Join(dir, artifact.name)
		if err := os.WriteFile(path, nil, 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.Truncate(path, artifact.bytes); err != nil {
			t.Fatal(err)
		}
	}
	want := "paddle"
	if runtime.GOOS == "darwin" {
		want = "system"
	}
	if got := readOCRResponse(t, s, "GET", ""); got.ModelState != "ready" || got.DownloadedBytes != got.TotalBytes || got.Engine != want || len(got.Notices) != 0 {
		t.Fatalf("ready state %+v", got)
	}
	readOCRResponse(t, s, "POST", `{"action":"use-paddle"}`)
	reopened := NewServer(s.Store, s.Token, "")
	if engine, dir := reopened.workerOCREnv(); engine != "paddle" || dir != s.ocrModelDir() {
		t.Fatalf("persisted engine = %q, directory = %q", engine, dir)
	}
	if runtime.GOOS == "darwin" {
		if got := readOCRResponse(t, reopened, "POST", `{"action":"use-system"}`); got.Engine != "system" || got.ModelState != "ready" {
			t.Fatalf("switch back to system: %+v", got)
		}
	}
}

func TestResolveOCREngine(t *testing.T) {
	for _, test := range []struct {
		platform, preferred string
		system, ready       bool
		want                string
	}{
		{"darwin", "", true, false, "system"},
		{"darwin", "", true, true, "system"},
		{"darwin", "system", true, true, "system"},
		{"darwin", "paddle", true, true, "paddle"},
		{"darwin", "paddle", true, false, "system"},
		{"darwin", "", false, true, "none"},
		{"windows", "", false, false, "none"},
		{"windows", "", false, true, "paddle"},
	} {
		if got := resolveOCREngine(test.platform, test.preferred, test.system, test.ready); got != test.want {
			t.Errorf("%+v: engine = %s", test, got)
		}
	}
}

func TestOCRInstallVerifiesEveryArtifactBeforePublishing(t *testing.T) {
	const first = "model A"
	const second = "dict B"
	var bad atomic.Bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/model":
			fmt.Fprint(w, first)
		case "/dictionary":
			if bad.Load() {
				fmt.Fprint(w, "alter!") // same length, different hash
			} else {
				fmt.Fprint(w, second)
			}
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()
	artifact := func(name, path, value string) ocrArtifact {
		hash := sha256.Sum256([]byte(value))
		return ocrArtifact{name, upstream.URL + path, int64(len(value)), hex.EncodeToString(hash[:])}
	}
	files := []ocrArtifact{artifact("det.onnx", "/model", first), artifact("rec.yml", "/dictionary", second)}
	dir := filepath.Join(t.TempDir(), "version")
	var progress atomic.Int64
	bad.Store(true)
	if name, _, reason := installOCRModel(context.Background(), upstream.Client(), dir, files, &progress); name != "rec.yml" || reason != "sha256" {
		t.Fatalf("bad dictionary result = %q %q", name, reason)
	}
	for _, path := range []string{dir, dir + ".download"} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("failed install exposed %s: %v", filepath.Base(path), err)
		}
	}
	bad.Store(false)
	progress.Store(0)
	if name, _, reason := installOCRModel(context.Background(), upstream.Client(), dir, files, &progress); reason != "" {
		t.Fatalf("retry failed for %q: %s", name, reason)
	}
	if got := progress.Load(); got != int64(len(first)+len(second)) {
		t.Fatalf("wrong progress %d", got)
	}
	for _, file := range files {
		got, err := os.ReadFile(filepath.Join(dir, file.name))
		hash := sha256.Sum256(got)
		if err != nil || hex.EncodeToString(hash[:]) != file.sha256 {
			t.Fatalf("bad published file %s: %v", file.name, err)
		}
	}
}

func TestOCRDownloadOnlyStartsOnceAndJoinsOnClose(t *testing.T) {
	s := ocrFixture(t)
	started := make(chan struct{}, 4)
	transport := http.DefaultTransport
	http.DefaultTransport = apiRoundTripper(func(r *http.Request) (*http.Response, error) {
		started <- struct{}{}
		<-r.Context().Done()
		return nil, r.Context().Err()
	})
	defer func() { s.Close(); http.DefaultTransport = transport }()
	if got := readOCRResponse(t, s, "GET", ""); got.ModelState != "missing" || len(started) != 0 {
		t.Fatalf("GET changed install state %+v", got)
	}
	for range 3 {
		if got := readOCRResponse(t, s, "POST", `{"action":"download"}`); got.ModelState != "downloading" {
			t.Fatalf("state %+v", got)
		}
	}
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("download did not start")
	}
	s.Close()
	if len(started) != 0 {
		t.Fatal("duplicate downloads")
	}
	if _, err := os.Stat(s.ocrModelDir() + ".download"); !os.IsNotExist(err) {
		t.Fatalf("download not cleaned on shutdown: %v", err)
	}
}

// Re-exec the test binary as a portable subprocess with a strictly small
// mock of the layout worker's stdout protocol. No PDF text is logged.
func init() {
	switch os.Getenv("NEOREAD_OCR_TEST_CHILD") {
	case "layout":
		if os.Getenv("NEOREAD_OCR_ENGINE") != "none" || os.Getenv("NEOREAD_OCR_MODEL_DIR") != "" {
			os.Exit(2)
		}
		fmt.Println(`{"event":"scan","page":2,"total":10}`)
		for deadline := time.Now().Add(8 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
			if _, err := os.Stat(os.Getenv("NEOREAD_OCR_TEST_EXIT")); err == nil {
				os.Exit(0)
			}
		}
		os.Exit(3)
	case "heartbeat":
		for page := 1; page <= 7; page++ {
			fmt.Printf("{\"event\":\"page\",\"page\":%d,\"total\":7}\n", page)
			time.Sleep(200 * time.Millisecond)
		}
		os.Exit(0)
	case "stall":
		time.Sleep(4 * time.Second)
		os.Exit(0)
	case "probe":
		for i, arg := range os.Args {
			if arg == "--scan-only" && i+2 < len(os.Args) && os.Args[i+1] == "--from-page" {
				if page, err := strconv.Atoi(os.Args[i+2]); err == nil && page == 6 {
					fmt.Println(`{"event":"scan","page":6,"total":12}`)
					os.Exit(0)
				}
			}
		}
		os.Exit(4)
	}
}

func setOCRChild(t *testing.T, mode string) {
	t.Helper()
	bin, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("NEOREAD_NODE", bin)
	t.Setenv("NEOREAD_PROCESSOR", filepath.Join(t.TempDir(), "test-worker"))
	t.Setenv("NEOREAD_OCR_TEST_CHILD", mode)
}

func waitOCRNotice(t *testing.T, s *Server) {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		got := readOCRResponse(t, s, "GET", "")
		if len(got.Notices) == 1 && got.Notices[0].DocumentID == "doc" {
			return
		}
	}
	t.Fatal("scan notification did not arrive")
}

func TestOCRScanVisibleWhileLayoutRuns(t *testing.T) {
	for _, library := range []string{"books", "papers"} {
		t.Run(library, func(t *testing.T) {
			s := ocrFixture(t)
			if _, err := s.Store.DB.Exec("UPDATE documents SET library=? WHERE id='doc'", library); err != nil {
				t.Fatal(err)
			}
			doc, err := s.Store.Document("doc")
			if err != nil {
				t.Fatal(err)
			}
			setOCRChild(t, "layout")
			exit := filepath.Join(s.Store.Root, "test-child-exit")
			t.Setenv("NEOREAD_OCR_TEST_EXIT", exit)
			t.Setenv("NEOREAD_OCR_ENGINE", "paddle")
			t.Setenv("NEOREAD_OCR_MODEL_DIR", "bad inherited path")
			ctx, cancel := context.WithCancel(context.Background())
			done := make(chan struct{})
			var layoutErr error
			go func() {
				defer close(done)
				layoutErr = s.runLayout(ctx, doc, filepath.Join(s.Store.Root, "work"), 0, 0, nil)
			}()
			defer func() { cancel(); <-done }()
			waitOCRNotice(t, s)
			select {
			case <-done:
				t.Fatalf("notification arrived after worker exited: %v", layoutErr)
			default:
			}
			if err := os.WriteFile(exit, nil, 0600); err != nil {
				t.Fatal(err)
			}
			<-done
			if layoutErr != nil {
				t.Fatal(layoutErr)
			}
		})
	}
}

func TestOCRProbeOnLegacyOpen(t *testing.T) {
	s := ocrFixture(t)
	setOCRChild(t, "probe")
	m := layoutManifest{Pages: 12, Blocks: []PDFBlock{{ID: "p6-b1", Label: "text", Page: 6}}}
	m.Blocks[0].Bounds.Width, m.Blocks[0].Bounds.Height = .7, .2
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(s.analysisDir("doc"), "manifest.json")
	if err = os.WriteFile(path, b, 0600); err != nil {
		t.Fatal(err)
	}
	if out := request(t, s, "PATCH", "/api/documents/doc", strings.NewReader(`{}`)); out.Code != 200 {
		t.Fatalf("open: %d %s", out.Code, out.Body)
	}
	waitOCRNotice(t, s)
	if preserved, err := os.ReadFile(path); err != nil || string(preserved) != string(b) {
		t.Fatal("probe changed existing layout", err)
	}
	m.ScanDetectionVersion = 1
	if page := cachedScanCandidate(m); page != 0 {
		t.Fatalf("new layout requires no probe, got page %d", page)
	}
	m.ScanDetectionVersion, m.Blocks[0].Label = 0, "image"
	if page := cachedScanCandidate(m); page != 0 {
		t.Fatalf("image-only layout requires no probe, got page %d", page)
	}
}

func TestLayoutTimeoutTracksInactivity(t *testing.T) {
	for _, test := range []struct {
		mode string
		want error
	}{{"heartbeat", nil}, {"stall", errLayoutIdle}} {
		t.Run(test.mode, func(t *testing.T) {
			s := ocrFixture(t)
			setOCRChild(t, test.mode)
			d, err := s.Store.Document("doc")
			if err != nil {
				t.Fatal(err)
			}
			err = s.runLayoutWithIdleTimeout(context.Background(), d, filepath.Join(s.Store.Root, "work"), 0, 0, nil, time.Second)
			if !errors.Is(err, test.want) {
				t.Fatalf("got %v, want %v", err, test.want)
			}
		})
	}
}
