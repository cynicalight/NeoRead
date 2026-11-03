package neoread

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func attachmentPaper(t *testing.T, s *Server, pages int) Document {
	t.Helper()
	w := uploadTo(t, s, "papers", "paper.pdf", testPDF(pages))
	if w.Code != 201 {
		t.Fatalf("paper: %d %s", w.Code, w.Body.String())
	}
	var d Document
	if err := json.Unmarshal(w.Body.Bytes(), &d); err != nil {
		t.Fatal(err)
	}
	return d
}

func TestPaperAttachmentDeleteDoesNotHoldArchiveLockWhileWaitingForImport(t *testing.T) {
	s := testServer(t)
	d := attachmentPaper(t, s, 1)
	a := addedAttachment(t, s, d.ID, "supplement.txt", []byte("supplement"))
	s.importMu.Lock()
	locked := true
	done := make(chan struct{})
	var code int
	defer func() {
		if locked {
			s.importMu.Unlock()
		}
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Error("attachment deletion did not finish")
		}
	}()
	go func() {
		code = request(t, s, "DELETE", "/api/documents/"+d.ID+"/attachments/"+a.ID, nil).Code
		close(done)
	}()
	// Wait for the real handler to block on importMu before testing writer access.
	blocked := false
	deadline := time.Now().Add(2 * time.Second)
	buffer := make([]byte, 1<<20)
	for !blocked && time.Now().Before(deadline) {
		for _, stack := range strings.Split(string(buffer[:runtime.Stack(buffer, true)]), "\n\n") {
			if strings.Contains(stack, "(*Server).deletePaperAttachment") && strings.Contains(stack, "sync.runtime_SemacquireMutex") {
				blocked = true
				break
			}
		}
		if !blocked {
			runtime.Gosched()
		}
	}
	if !blocked {
		t.Fatal("deletion did not reach the import lock")
	}
	if s.libraryArchiveMu.TryLock() {
		s.libraryArchiveMu.Unlock()
	} else {
		t.Error("waiting attachment deletion blocks archive writers and can deadlock document cleanup")
	}
	s.importMu.Unlock()
	locked = false
	select {
	case <-done:
		if code != 204 {
			t.Fatalf("delete: %d", code)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("deletion stalled after releasing import lock")
	}
}
func attachmentBody(t *testing.T, names []string, data []byte) (*bytes.Buffer, string) {
	t.Helper()
	var body bytes.Buffer
	m := multipart.NewWriter(&body)
	for _, name := range names {
		f, err := m.CreateFormFile("file", name)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = f.Write(data)
	}
	_ = m.Close()
	return &body, m.FormDataContentType()
}
func sendAttachment(t *testing.T, s *Server, doc string, names []string, data []byte) *httptest.ResponseRecorder {
	t.Helper()
	body, contentType := attachmentBody(t, names, data)
	r := httptest.NewRequest("POST", "http://127.0.0.1:17840/api/documents/"+doc+"/attachments", body)
	r.Header.Set("Authorization", "Bearer test-secret")
	r.Header.Set("Content-Type", contentType)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	return w
}
func addedAttachment(t *testing.T, s *Server, doc, name string, data []byte) PaperAttachment {
	t.Helper()
	w := sendAttachment(t, s, doc, []string{name}, data)
	if w.Code != 201 {
		t.Fatalf("add: %d %s", w.Code, w.Body.String())
	}
	var a PaperAttachment
	if err := json.Unmarshal(w.Body.Bytes(), &a); err != nil {
		t.Fatal(err)
	}
	return a
}
func attachmentList(t *testing.T, s *Server, doc string) []PaperAttachment {
	t.Helper()
	w := request(t, s, "GET", "/api/documents/"+doc+"/attachments", nil)
	if w.Code != 200 {
		t.Fatalf("list: %d %s", w.Code, w.Body.String())
	}
	var items []PaperAttachment
	if err := json.Unmarshal(w.Body.Bytes(), &items); err != nil {
		t.Fatal(err)
	}
	return items
}
func attachmentJSON(t *testing.T, s *Server, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest("POST", "http://127.0.0.1:17840"+path, strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer test-secret")
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	return w
}
func TestPaperAttachmentsStoreDedupeAndDownload(t *testing.T) {
	s := testServer(t)
	d := attachmentPaper(t, s, 1)
	data := []byte("<script>active content stays a download</script>")
	a := addedAttachment(t, s, d.ID, "补充材料.html", data)
	if a.Kind != "file" || a.Title != "补充材料.html" || a.Size != int64(len(data)) {
		t.Fatalf("metadata: %+v", a)
	}
	w := request(t, s, "PATCH", "/api/documents/"+d.ID+"/attachments/"+a.ID, strings.NewReader(`{"title":"实验补充"}`))
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	w = sendAttachment(t, s, d.ID, []string{"different.html"}, data)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "实验补充") || !strings.Contains(w.Body.String(), a.ID) {
		t.Fatalf("duplicate renamed: %d %s", w.Code, w.Body.String())
	}
	w = request(t, s, "GET", "/api/documents/"+d.ID+"/attachments/"+a.ID+"/file", nil)
	if w.Code != 200 || !bytes.Equal(w.Body.Bytes(), data) || w.Header().Get("Content-Type") != "application/octet-stream" || !strings.HasPrefix(w.Header().Get("Content-Disposition"), "attachment;") || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("unsafe download: %d %v", w.Code, w.Header())
	}
	saved, _ := s.Store.Document(d.ID)
	if saved.AttachmentCount != 1 || saved.LastOpenedAt != d.LastOpenedAt || saved.Percentage != 0 {
		t.Fatalf("changed paper state: %+v", saved)
	}
	files, err := os.ReadDir(filepath.Join(s.Store.Root, "attachments"))
	if err != nil || len(files) != 1 || len(files[0].Name()) != 64 {
		t.Fatalf("storage: %v %v", files, err)
	}
	// A reopened store keeps labels and file ownership.
	reopened, err := OpenStore(s.Store.Root)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.DB.Close()
	items, err := reopened.paperAttachments(d.ID)
	if err != nil || len(items) != 1 || items[0].Title != "实验补充" {
		t.Fatalf("reopen: %+v %v", items, err)
	}
}
func TestPaperAttachmentLinksAndOwnershipBoundaries(t *testing.T) {
	s := testServer(t)
	d := attachmentPaper(t, s, 1)
	other := attachmentPaper(t, s, 2)
	path := "/api/documents/" + d.ID + "/attachments"
	for _, raw := range []string{`{"url":"javascript:alert(1)"}`, `{"url":"file:///tmp/a"}`, `{"url":"https://u:p@example.org"}`, `{"url":"https://example.org","title":"bad\nname"}`} {
		if w := attachmentJSON(t, s, path, raw); w.Code != 400 {
			t.Fatalf("unsafe link: %s %d", raw, w.Code)
		}
	}
	w := attachmentJSON(t, s, path, `{"url":"https://example.org/supplement"}`)
	if w.Code != 201 {
		t.Fatal(w.Body.String())
	}
	var a PaperAttachment
	_ = json.Unmarshal(w.Body.Bytes(), &a)
	if a.Title != "example.org" || a.Kind != "link" {
		t.Fatalf("link: %+v", a)
	}
	if w := attachmentJSON(t, s, path, `{"title":"other","url":"https://example.org/supplement"}`); w.Code != 200 {
		t.Fatalf("link duplicate %d", w.Code)
	}
	for _, method := range []string{"PATCH", "DELETE", "GET"} {
		suffix := ""
		if method == "GET" {
			suffix = "/file"
		}
		w := request(t, s, method, "/api/documents/"+other.ID+"/attachments/"+a.ID+suffix, strings.NewReader(`{"title":"stolen"}`))
		if w.Code != 404 {
			t.Fatalf("cross parent %s: %d", method, w.Code)
		}
	}
	r := httptest.NewRequest("GET", "http://127.0.0.1:17840"+path, nil)
	out := httptest.NewRecorder()
	s.Handler().ServeHTTP(out, r)
	if out.Code != 401 {
		t.Fatalf("unauthed list: %d", out.Code)
	}
	if len(attachmentList(t, s, d.ID)) != 1 {
		t.Fatal("attachment changed")
	}
}
func TestPaperAttachmentsFollowTrashMergeAndPurge(t *testing.T) {
	s := testServer(t)
	master := attachmentPaper(t, s, 1)
	other := attachmentPaper(t, s, 2)
	data := []byte("shared supplementary data")
	a := addedAttachment(t, s, other.ID, "data.csv", data)
	addedAttachment(t, s, master.ID, "different.csv", data)
	if w := request(t, s, "POST", "/api/documents/"+master.ID+"/merge", strings.NewReader(`{"from":["`+other.ID+`"]}`)); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if len(attachmentList(t, s, master.ID)) != 1 {
		t.Fatal("merge did not deduplicate")
	}
	if w := request(t, s, "GET", "/api/documents/"+other.ID+"/attachments", nil); w.Code != 404 {
		t.Fatal("trashed attachments exposed")
	}
	if w := request(t, s, "POST", "/api/documents/"+other.ID+"/restore", nil); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if got := attachmentList(t, s, other.ID); len(got) != 1 || got[0].ID != a.ID {
		t.Fatalf("restore lost attachment: %+v", got)
	}
	if w := request(t, s, "DELETE", "/api/documents/"+other.ID, nil); w.Code != 204 {
		t.Fatal(w.Body.String())
	}
	keep := attachmentList(t, s, master.ID)[0]
	if w := request(t, s, "GET", "/api/documents/"+master.ID+"/attachments/"+keep.ID+"/file", nil); w.Code != 200 || !bytes.Equal(w.Body.Bytes(), data) {
		t.Fatal("purge removed shared bytes")
	}
	if w := request(t, s, "PATCH", "/api/documents/"+master.ID, strings.NewReader(`{"library":"books"}`)); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if len(attachmentList(t, s, master.ID)) != 1 {
		t.Fatal("library move lost attachments")
	}
	if w := request(t, s, "DELETE", "/api/documents/"+master.ID+"/attachments/"+keep.ID, nil); w.Code != 204 {
		t.Fatal(w.Body.String())
	}
	files, _ := os.ReadDir(filepath.Join(s.Store.Root, "attachments"))
	if len(files) != 0 {
		t.Fatal("last owner did not clean file")
	}
	// Unique attachments are copied as well; original owner remains recoverable.
	another := attachmentPaper(t, s, 3)
	target := attachmentPaper(t, s, 4)
	addedAttachment(t, s, another.ID, "unique.zip", []byte("unique"))
	if w := request(t, s, "POST", "/api/documents/"+target.ID+"/merge", strings.NewReader(`{"from":["`+another.ID+`"]}`)); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if len(attachmentList(t, s, target.ID)) != 1 {
		t.Fatal("merge lost unique attachment")
	}
	if w := request(t, s, "DELETE", "/api/documents/"+target.ID, nil); w.Code != 204 {
		t.Fatal(w.Body.String())
	}
	if w := request(t, s, "POST", "/api/documents/"+another.ID+"/restore", nil); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	restored := attachmentList(t, s, another.ID)[0]
	if w := request(t, s, "GET", "/api/documents/"+another.ID+"/attachments/"+restored.ID+"/file", nil); w.Code != 200 {
		t.Fatal("original owner lost bytes")
	}
}
func TestPaperAttachmentUploadFailureLeavesNoRecordOrFile(t *testing.T) {
	s := testServer(t)
	d := attachmentPaper(t, s, 1)
	if w := sendAttachment(t, s, d.ID, []string{"one.txt", "two.txt"}, []byte("bad")); w.Code != 400 {
		t.Fatalf("multiple accepted: %d", w.Code)
	}
	body, ct := attachmentBody(t, []string{"partial.txt"}, []byte("partial"))
	data := body.Bytes()
	r := httptest.NewRequest("POST", "http://127.0.0.1:17840/api/documents/"+d.ID+"/attachments", bytes.NewReader(data[:len(data)-50]))
	r.Header.Set("Authorization", "Bearer test-secret")
	r.Header.Set("Content-Type", ct)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != 400 {
		t.Fatalf("partial accepted: %d", w.Code)
	}
	if _, err := s.Store.DB.Exec(`CREATE TRIGGER reject_attachment BEFORE INSERT ON paper_attachments BEGIN SELECT RAISE(ABORT,'storage failure'); END`); err != nil {
		t.Fatal(err)
	}
	if w := sendAttachment(t, s, d.ID, []string{"file.txt"}, []byte("complete")); w.Code != 500 {
		t.Fatalf("failed insert: %d", w.Code)
	}
	if len(attachmentList(t, s, d.ID)) != 0 {
		t.Fatal("failed upload saved record")
	}
	files, _ := os.ReadDir(filepath.Join(s.Store.Root, "attachments"))
	if len(files) != 0 {
		t.Fatal("failed upload left files")
	}
}

type pausedAttachmentReader struct {
	prefix, rest io.Reader
	waiting      chan struct{}
	resume       chan struct{}
	paused       bool
}

func (r *pausedAttachmentReader) Read(p []byte) (int, error) {
	if r.prefix != nil {
		n, err := r.prefix.Read(p)
		if n > 0 {
			return n, nil
		}
		if err == io.EOF {
			r.prefix = nil
		} else {
			return n, err
		}
	}
	if !r.paused {
		r.paused = true
		close(r.waiting)
		<-r.resume
	}
	return r.rest.Read(p)
}
func TestPaperAttachmentUploadRechecksParentAfterTransfer(t *testing.T) {
	s := testServer(t)
	d := attachmentPaper(t, s, 1)
	body, ct := attachmentBody(t, []string{"late.csv"}, bytes.Repeat([]byte("x"), 2000))
	data := body.Bytes()
	paused := &pausedAttachmentReader{prefix: bytes.NewReader(data[:300]), rest: bytes.NewReader(data[300:]), waiting: make(chan struct{}), resume: make(chan struct{})}
	r := httptest.NewRequest("POST", "http://127.0.0.1:17840/api/documents/"+d.ID+"/attachments", paused)
	r.Header.Set("Authorization", "Bearer test-secret")
	r.Header.Set("Content-Type", ct)
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { w := httptest.NewRecorder(); s.Handler().ServeHTTP(w, r); done <- w }()
	select {
	case <-paused.waiting:
	case <-time.After(5 * time.Second):
		t.Fatal("upload did not start")
	}
	w := request(t, s, "POST", "/api/documents/"+d.ID+"/trash", nil)
	close(paused.resume)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	select {
	case result := <-done:
		if result.Code != 404 {
			t.Fatalf("late upload committed: %d %s", result.Code, result.Body.String())
		}
	case <-time.After(5 * time.Second):
		t.Fatal("upload did not finish")
	}
	files, _ := os.ReadDir(filepath.Join(s.Store.Root, "attachments"))
	if len(files) != 0 {
		t.Fatal("late upload left files")
	}
}

func TestPaperAttachmentFailedDeletionKeepsOwnedBytes(t *testing.T) {
	s := testServer(t)
	d := attachmentPaper(t, s, 1)
	other := attachmentPaper(t, s, 2)
	a := addedAttachment(t, s, d.ID, "supplement.pdf", testPDF(2))
	if w := request(t, s, "GET", "/api/documents/"+other.ID+"/attachments/"+a.ID+"/file", nil); w.Code != 404 {
		t.Fatal("cross-paper file exposed")
	}
	if _, err := s.Store.DB.Exec(`CREATE TRIGGER keep_document BEFORE DELETE ON documents BEGIN SELECT RAISE(ABORT,'storage failure'); END`); err != nil {
		t.Fatal(err)
	}
	if w := request(t, s, "DELETE", "/api/documents/"+d.ID, nil); w.Code != 500 {
		t.Fatalf("delete should fail: %d", w.Code)
	}
	if len(attachmentList(t, s, d.ID)) != 1 {
		t.Fatal("failed deletion lost attachment ownership")
	}
	if w := request(t, s, "GET", "/api/documents/"+d.ID+"/attachments/"+a.ID+"/file", nil); w.Code != 200 || !bytes.Equal(w.Body.Bytes(), testPDF(2)) {
		t.Fatal("failed deletion lost bytes")
	}
}

// A stalled response keeps the real download handle open while another request
// removes ownership. Permission denial below models Windows' sharing violation.
type blockedAttachmentResponse struct {
	*httptest.ResponseRecorder
	started, release chan struct{}
	once             sync.Once
	writeErr         error
}

func (w *blockedAttachmentResponse) Write(p []byte) (int, error) {
	w.once.Do(func() { close(w.started) })
	<-w.release
	if w.writeErr != nil {
		return 0, w.writeErr
	}
	return w.ResponseRecorder.Write(p)
}
func startBlockedAttachmentDownload(t *testing.T, s *Server, docID, attachmentID string, writeErr error) (*blockedAttachmentResponse, <-chan struct{}, func()) {
	t.Helper()
	w := &blockedAttachmentResponse{ResponseRecorder: httptest.NewRecorder(), started: make(chan struct{}), release: make(chan struct{}), writeErr: writeErr}
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(w.release) }) }
	done := make(chan struct{})
	r := httptest.NewRequest("GET", "http://127.0.0.1:17840/api/documents/"+docID+"/attachments/"+attachmentID+"/file", nil)
	r.Header.Set("Authorization", "Bearer test-secret")
	go func() { s.Handler().ServeHTTP(w, r); close(done) }()
	t.Cleanup(func() {
		release()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("download did not stop")
		}
	})
	select {
	case <-w.started:
	case <-time.After(5 * time.Second):
		t.Fatal("download did not start")
	}
	return w, done, release
}
func TestPaperAttachmentDownloadRetriesFailedCleanup(t *testing.T) {
	if runtime.GOOS != "windows" && os.Geteuid() == 0 {
		t.Skip("requires directory permissions or Windows sharing violations")
	}
	for _, test := range []struct {
		name     string
		purge    bool
		writeErr error
	}{{name: "complete"}, {name: "interrupted", writeErr: io.ErrClosedPipe}, {name: "purge", purge: true}} {
		t.Run(test.name, func(t *testing.T) {
			s := testServer(t)
			d := attachmentPaper(t, s, 1)
			data := testPDF(2)
			a := addedAttachment(t, s, d.ID, "supplement.pdf", data)
			owned, err := s.Store.paperAttachments(d.ID)
			if err != nil {
				t.Fatal(err)
			}
			directory := filepath.Join(s.Store.Root, "attachments")
			path := filepath.Join(directory, owned[0].Hash)
			w, done, release := startBlockedAttachmentDownload(t, s, d.ID, a.ID, test.writeErr)
			if runtime.GOOS != "windows" {
				if err := os.Chmod(directory, 0500); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = os.Chmod(directory, 0700) })
			}
			endpoint := "/api/documents/" + d.ID + "/attachments/" + a.ID
			if test.purge {
				endpoint = "/api/documents/" + d.ID
			}
			deleted := make(chan *httptest.ResponseRecorder, 1)
			go func() { deleted <- request(t, s, "DELETE", endpoint, nil) }()
			select {
			case response := <-deleted:
				if response.Code != 204 {
					t.Fatalf("delete: %d %s", response.Code, response.Body.String())
				}
			case <-time.After(3 * time.Second):
				t.Fatal("download blocked unrelated library mutations")
			}
			if _, err := os.Stat(path); err != nil {
				t.Fatalf("expected an in-flight file awaiting cleanup: %v", err)
			}
			if runtime.GOOS != "windows" {
				if err := os.Chmod(directory, 0700); err != nil {
					t.Fatal(err)
				}
			}
			release()
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Fatal("download did not complete")
			}
			if _, err := os.Stat(path); !os.IsNotExist(err) {
				t.Fatalf("deleted attachment bytes survived download completion: %v", err)
			}
			if test.writeErr == nil && !bytes.Equal(w.Body.Bytes(), data) {
				t.Fatal("in-flight download was truncated")
			}
		})
	}
}
func TestPaperAttachmentDownloadCompletionKeepsReattachedFile(t *testing.T) {
	s := testServer(t)
	d := attachmentPaper(t, s, 1)
	data := testPDF(2)
	a := addedAttachment(t, s, d.ID, "supplement.pdf", data)
	_, done, release := startBlockedAttachmentDownload(t, s, d.ID, a.ID, nil)
	if w := request(t, s, "DELETE", "/api/documents/"+d.ID+"/attachments/"+a.ID, nil); w.Code != 204 {
		t.Fatal(w.Body.String())
	}
	replacement := addedAttachment(t, s, d.ID, "reimported.pdf", data)
	release()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("download did not complete")
	}
	if w := request(t, s, "GET", "/api/documents/"+d.ID+"/attachments/"+replacement.ID+"/file", nil); w.Code != 200 || !bytes.Equal(w.Body.Bytes(), data) {
		t.Fatal("download completion deleted reattached content")
	}
}
