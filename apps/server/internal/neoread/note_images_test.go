package neoread

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"hash/crc32"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"neoread.local/server/internal/diagnostics"
)

func testNotePNG(t *testing.T, blue uint8) []byte {
	t.Helper()
	m := image.NewNRGBA(image.Rect(0, 0, 2, 2))
	m.SetNRGBA(0, 0, color.NRGBA{B: blue, A: 255})
	var b bytes.Buffer
	if err := png.Encode(&b, m); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func noteImageURL(path string) string {
	return "/api/note-images/" + strings.TrimPrefix(path, "assets/")
}

func addTestNoteImage(t *testing.T, s *Server, documentID string, data []byte, ext string) string {
	t.Helper()
	w := request(t, s, "POST", "/api/documents/"+documentID+"/note-images", bytes.NewReader(data))
	if w.Code != 201 {
		t.Fatalf("upload: %d %s", w.Code, w.Body.String())
	}
	var result struct{ Path string }
	want := fmt.Sprintf("assets/%x.%s", sha256.Sum256(data), ext)
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || result.Path != want {
		t.Fatalf("image path: %s, want %s (%v)", w.Body.String(), want, err)
	}
	return result.Path
}

func requireTestNoteImage(t *testing.T, s *Server, path string, data []byte, mediaType string) {
	t.Helper()
	w := request(t, s, "GET", noteImageURL(path), nil)
	if w.Code != 200 || !bytes.Equal(w.Body.Bytes(), data) || w.Header().Get("Content-Type") != mediaType || w.Header().Get("X-Content-Type-Options") != "nosniff" || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("read %s: status %d headers %v (%d bytes)", path, w.Code, w.Header(), w.Body.Len())
	}
}

func putNoteImageMarkdown(t *testing.T, s *Server, doc, body string) {
	t.Helper()
	w := request(t, s, "PUT", "/api/documents/"+doc+"/note", strings.NewReader(jsonText(documentNote{Body: body})))
	if w.Code != 200 {
		t.Fatalf("save note: %d %s", w.Code, w.Body.String())
	}
}

func assertNoteImageStatus(t *testing.T, s *Server, method, path string, body io.Reader, want int) {
	t.Helper()
	if w := request(t, s, method, path, body); w.Code != want {
		t.Fatalf("%s %s: %d want %d (%s)", method, path, w.Code, want, w.Body.String())
	}
}

func TestNoteImageUploadValidationAndAuthentication(t *testing.T) {
	s := testServer(t)
	doc := attachmentPaper(t, s, 1).ID
	upload := "/api/documents/" + doc + "/note-images"
	pngData := testNotePNG(t, 1)
	var jpegData, gifData bytes.Buffer
	paletted := image.NewPaletted(image.Rect(0, 0, 1, 1), color.Palette{color.Black, color.White})
	if err := jpeg.Encode(&jpegData, paletted, nil); err != nil {
		t.Fatal(err)
	}
	if err := gif.EncodeAll(&gifData, &gif.GIF{Image: []*image.Paletted{paletted, paletted}, Delay: []int{4, 4}}); err != nil {
		t.Fatal(err)
	}
	webpData, err := base64.StdEncoding.DecodeString("UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQvVa0uv+BiOh/AAA=")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		ext, media string
		data       []byte
	}{
		{"png", "image/png", pngData}, {"jpg", "image/jpeg", jpegData.Bytes()},
		{"gif", "image/gif", gifData.Bytes()}, {"webp", "image/webp", webpData},
	} {
		t.Run(tc.ext, func(t *testing.T) {
			path := addTestNoteImage(t, s, doc, tc.data, tc.ext)
			requireTestNoteImage(t, s, path, tc.data, tc.media)
		})
	}
	path := fmt.Sprintf("assets/%x.png", sha256.Sum256(pngData))
	wrongType := httptest.NewRequest("POST", "http://127.0.0.1:17840"+upload, bytes.NewReader(pngData))
	wrongType.Header.Set("Authorization", "Bearer test-secret")
	wrongType.Header.Set("Content-Type", "image/svg+xml")
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, wrongType)
	if w.Code != 201 || !strings.Contains(w.Body.String(), path) {
		t.Fatalf("trusted upload Content-Type: %d %s", w.Code, w.Body.String())
	}
	for method, url := range map[string]string{"GET": noteImageURL(path) + "?token=test-secret", "POST": upload} {
		unauth := httptest.NewRequest(method, "http://127.0.0.1:17840"+url, nil)
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, unauth)
		if w.Code != 401 {
			t.Fatalf("unauthenticated %s: %d", method, w.Code)
		}
	}
	for _, url := range []string{noteImageURL(strings.TrimSuffix(path, ".png") + ".gif"), noteImageURL(strings.ToUpper(path)), "/api/note-images/%2e%2e%2fnotes.png"} {
		assertNoteImageStatus(t, s, "GET", url, nil, 404)
	}
	oversized := bytes.Clone(pngData)
	binary.BigEndian.PutUint32(oversized[16:20], maxNoteImageAxis+1)
	binary.BigEndian.PutUint32(oversized[29:33], crc32.ChecksumIEEE(oversized[12:29]))
	var tooManyFrames bytes.Buffer
	frames := make([]*image.Paletted, maxNoteImageFrames+1)
	for i := range frames {
		frames[i] = paletted
	}
	if err := gif.EncodeAll(&tooManyFrames, &gif.GIF{Image: frames, Delay: make([]int, len(frames))}); err != nil {
		t.Fatal(err)
	}
	animatedWebP, err := base64.StdEncoding.DecodeString("UklGRoQAAABXRUJQVlA4WAoAAAACAAAAAAAAAAAAQU5JTQYAAAAAAAAAAABBTk1GKAAAAAAAAAAAAAAAAAAAADIAAAJWUDhMDwAAAC8AAAAABxD9j/4HIqL/AQBBTk1GKAAAAAAAAAAAAAAAAAAAADIAAABWUDhMDwAAAC8AAAAAB1DAiP4HIqL/AQA=")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		data []byte
		code int
	}{
		{[]byte(`<svg xmlns="http://www.w3.org/2000/svg"/>`), 415}, {nil, 400},
		{pngData[:len(pngData)-8], 400}, {tooManyFrames.Bytes(), 400}, {animatedWebP, 400},
	} {
		assertNoteImageStatus(t, s, "POST", upload, bytes.NewReader(tc.data), tc.code)
	}
	// Wrap the reader to exercise the streaming limit, not just Content-Length.
	assertNoteImageStatus(t, s, "POST", upload, io.LimitReader(bytes.NewReader(make([]byte, maxNoteImageBytes+1)), maxNoteImageBytes+1), 413)
	logs, err := diagnostics.New(filepath.Join(s.Store.Root, "logs"), "note-images")
	if err != nil {
		t.Fatal(err)
	}
	s.SetDiagnostics(logs)
	const private = "private-clip-content"
	rejected := request(t, s, "POST", upload, bytes.NewReader(append(oversized, private...)))
	if rejected.Code != 400 {
		t.Fatalf("oversized dimensions: %d", rejected.Code)
	}
	logFiles, err := os.ReadDir(logs.Dir)
	if err != nil {
		t.Fatal(err)
	}
	matched := false
	for _, entry := range logFiles {
		data, err := os.ReadFile(filepath.Join(logs.Dir, entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(data, []byte(private)) {
			t.Fatal("image content leaked into diagnostics")
		}
		for _, line := range bytes.Split(data, []byte("\n")) {
			var event map[string]any
			if json.Unmarshal(line, &event) == nil && event["event"] == "note_image.upload_rejected" &&
				event["requestId"] == rejected.Header().Get("X-NeoRead-Request-ID") && event["reasonCode"] == "raster_bounds" {
				matched = true
			}
		}
	}
	if !matched {
		t.Fatal("missing correlated image validation diagnostic")
	}
	entries, err := os.ReadDir(filepath.Join(s.Store.Root, "attachments"))
	if err != nil || len(entries) != 4 {
		t.Fatalf("rejected or repeated uploads left files: %v (%v)", entries, err)
	}
}

func TestNoteImagesShareAttachmentBytesBothWays(t *testing.T) {
	for _, imageFirst := range []bool{false, true} {
		t.Run(fmt.Sprint(imageFirst), func(t *testing.T) {
			s := testServer(t)
			docs := uploadPapers(t, s, 2)
			data := testNotePNG(t, 4)
			path := fmt.Sprintf("assets/%x.png", sha256.Sum256(data))
			var attachment PaperAttachment
			if imageFirst {
				addTestNoteImage(t, s, docs[0], data, "png")
				attachment = addedAttachment(t, s, docs[1], "copy.png", data)
			} else {
				attachment = addedAttachment(t, s, docs[1], "copy.png", data)
				assertNoteImageStatus(t, s, "GET", noteImageURL(path), nil, 404)
				addTestNoteImage(t, s, docs[0], data, "png")
			}
			entries, err := os.ReadDir(filepath.Join(s.Store.Root, "attachments"))
			if err != nil || len(entries) != 1 || entries[0].Name() != fmt.Sprintf("%x", sha256.Sum256(data)) {
				t.Fatalf("attachment and image did not dedupe: %v (%v)", entries, err)
			}
			attachmentURL := "/api/documents/" + docs[1] + "/attachments/" + attachment.ID
			if imageFirst {
				assertNoteImageStatus(t, s, "DELETE", "/api/documents/"+docs[0], nil, 204)
				w := request(t, s, "GET", attachmentURL+"/file", nil)
				if w.Code != 200 || !bytes.Equal(w.Body.Bytes(), data) || w.Header().Get("Content-Type") != "application/octet-stream" {
					t.Fatalf("note image purge broke attachment download: %d %v", w.Code, w.Header())
				}
				assertNoteImageStatus(t, s, "DELETE", attachmentURL, nil, 204)
			} else {
				assertNoteImageStatus(t, s, "DELETE", attachmentURL, nil, 204)
				requireTestNoteImage(t, s, path, data, "image/png")
				assertNoteImageStatus(t, s, "DELETE", "/api/documents/"+docs[0], nil, 204)
			}
			assertNoteImageStatus(t, s, "GET", noteImageURL(path), nil, 404)
			if entries, err = os.ReadDir(filepath.Join(s.Store.Root, "attachments")); err != nil || len(entries) != 0 {
				t.Fatalf("last owner did not reclaim blob: %v (%v)", entries, err)
			}
		})
	}
}

func TestNoteImageMarkdownCopyPinsPaperNotesAndAnnotationUndo(t *testing.T) {
	s := testServer(t)
	docs := uploadPapers(t, s, 3)
	data := testNotePNG(t, 5)
	path := addTestNoteImage(t, s, docs[0], data, "png")
	noteData := testNotePNG(t, 10)
	notePath := addTestNoteImage(t, s, docs[0], noteData, "png")
	body := "A quoted \"note\" and backslash \\\n\n![clipboard][clip]\n\n[clip]: <" + notePath + "> \"Clipboard image\""
	putNoteImageMarkdown(t, s, docs[1], body)
	putNoteImageMarkdown(t, s, docs[1], body)
	annotationURL := "/api/documents/" + docs[2] + "/annotations"
	a := Annotation{Kind: "note", Location: json.RawMessage(`{"type":"pdf","page":1}`)}
	w := request(t, s, "POST", annotationURL, strings.NewReader(jsonText(a)))
	var saved Annotation
	if w.Code != 201 || json.Unmarshal(w.Body.Bytes(), &saved) != nil || saved.ID == "" {
		t.Fatalf("create annotation: %d %s", w.Code, w.Body.String())
	}
	markdown := "![pasted](" + path + ")"
	assertNoteImageStatus(t, s, "PATCH", annotationURL+"/"+saved.ID, strings.NewReader(jsonText(map[string]string{"note": markdown})), 200)
	undoRequest := func(method, url string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "http://127.0.0.1:17840"+url, nil)
		r.Header.Set("Authorization", "Bearer test-secret")
		r.Header.Set(annotationUndoHeader, "note-image-test")
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		return w
	}
	w = undoRequest("DELETE", annotationURL+"/"+saved.ID)
	if w.Code != 204 {
		t.Fatalf("delete annotation: %d %s", w.Code, w.Body.String())
	}
	assertNoteImageStatus(t, s, "DELETE", "/api/documents/"+docs[0], nil, 204)
	requireTestNoteImage(t, s, path, data, "image/png")
	putNoteImageMarkdown(t, s, docs[1], "Edited without image")
	requireTestNoteImage(t, s, notePath, noteData, "image/png")
	assertNoteImageStatus(t, s, "DELETE", "/api/documents/"+docs[1], nil, 204)
	assertNoteImageStatus(t, s, "GET", noteImageURL(notePath), nil, 404)
	requireTestNoteImage(t, s, path, data, "image/png")
	w = undoRequest("POST", annotationURL+"/undo")
	if w.Code != 200 || !strings.Contains(w.Body.String(), markdown) {
		t.Fatalf("undo lost pasted path: %d %s", w.Code, w.Body.String())
	}
	assertNoteImageStatus(t, s, "DELETE", "/api/documents/"+docs[2], nil, 204)
	assertNoteImageStatus(t, s, "GET", noteImageURL(path), nil, 404)
}

func TestNoteImageJoinRestoreAndCandidateOnlyEmptyTrash(t *testing.T) {
	s := testServer(t)
	docs := uploadPapers(t, s, 2)
	data := testNotePNG(t, 6)
	linked := addTestNoteImage(t, s, docs[1], data, "png")
	draft := addTestNoteImage(t, s, docs[1], testNotePNG(t, 7), "png")
	body := "Longer note\n\n![joined](" + linked + ")"
	putNoteImageMarkdown(t, s, docs[0], "Shorter note")
	putNoteImageMarkdown(t, s, docs[1], body)
	assertNoteImageStatus(t, s, "POST", "/api/documents/"+docs[0]+"/merge", strings.NewReader(jsonText(map[string][]string{"from": docs[1:]})), 200)
	assertNoteImageStatus(t, s, "POST", "/api/documents/"+docs[1]+"/note-images", bytes.NewReader(data), 404)
	assertNoteImageStatus(t, s, "POST", "/api/documents/"+docs[1]+"/restore", nil, 200)
	w := request(t, s, "GET", "/api/documents/"+docs[1]+"/note", nil)
	if w.Code != 200 || !strings.Contains(w.Body.String(), linked) {
		t.Fatalf("restore lost note: %d %s", w.Code, w.Body.String())
	}
	requireTestNoteImage(t, s, linked, data, "image/png")
	assertNoteImageStatus(t, s, "GET", noteImageURL(draft), nil, 200)
	assertNoteImageStatus(t, s, "POST", "/api/documents/"+docs[1]+"/trash", nil, 200)
	unrelated := filepath.Join(s.Store.Root, "attachments", strings.Repeat("f", 64))
	if err := os.WriteFile(unrelated, []byte("outside purge candidates"), 0600); err != nil {
		t.Fatal(err)
	}
	assertNoteImageStatus(t, s, "DELETE", "/api/trash?library=papers", nil, 200)
	requireTestNoteImage(t, s, linked, data, "image/png")
	assertNoteImageStatus(t, s, "GET", noteImageURL(draft), nil, 404)
	w = request(t, s, "GET", "/api/documents/"+docs[0]+"/note", nil)
	if w.Code != 200 || !strings.Contains(w.Body.String(), linked) {
		t.Fatalf("merge lost note: %d %s", w.Code, w.Body.String())
	}
	if _, err := os.Stat(unrelated); err != nil {
		t.Fatalf("empty trash touched unrelated file: %v", err)
	}
}

func TestNoteImageUploadCancellationAndPurgeRace(t *testing.T) {
	for _, cancelled := range []bool{false, true} {
		t.Run(fmt.Sprint(cancelled), func(t *testing.T) {
			s := testServer(t)
			doc := attachmentPaper(t, s, 1).ID
			data := testNotePNG(t, 8)
			paused := &pausedAttachmentReader{prefix: bytes.NewReader(data[:20]), rest: bytes.NewReader(data[20:]), waiting: make(chan struct{}), resume: make(chan struct{})}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			r := httptest.NewRequestWithContext(ctx, "POST", "http://127.0.0.1:17840/api/documents/"+doc+"/note-images", paused)
			r.Header.Set("Authorization", "Bearer test-secret")
			w := httptest.NewRecorder()
			done := make(chan struct{})
			go func() { defer close(done); s.Handler().ServeHTTP(w, r) }()
			resumed := false
			defer func() {
				if !resumed {
					close(paused.resume)
				}
			}()
			select {
			case <-paused.waiting:
			case <-time.After(5 * time.Second):
				t.Fatal("upload did not start")
			}
			want := 404
			if cancelled {
				cancel()
				want = 400
			} else {
				assertNoteImageStatus(t, s, "DELETE", "/api/documents/"+doc, nil, 204)
			}
			close(paused.resume)
			resumed = true
			select {
			case <-done:
				if w.Code != want {
					t.Fatalf("late or cancelled upload: %d want %d (%s)", w.Code, want, w.Body.String())
				}
			case <-time.After(5 * time.Second):
				t.Fatal("upload did not finish")
			}
			if entries, err := os.ReadDir(filepath.Join(s.Store.Root, "attachments")); err != nil || len(entries) != 0 {
				t.Fatalf("unfinished upload left files: %v (%v)", entries, err)
			}
		})
	}
}

func TestNoteImageRecoveryKeepsPublishedPinsAndRemovesAbandonedFiles(t *testing.T) {
	s := testServer(t)
	doc := attachmentPaper(t, s, 1).ID
	data := testNotePNG(t, 9)
	path := addTestNoteImage(t, s, doc, data, "png")
	root := s.Store.Root
	dir := filepath.Join(root, "attachments")
	candidate, err := os.CreateTemp(dir, ".note-image-*")
	if err != nil {
		t.Fatal(err)
	}
	if err := candidate.Close(); err != nil {
		t.Fatal(err)
	}
	orphan := fmt.Sprintf("%x", sha256.Sum256(nil))
	if err := s.Store.publishAttachmentBlob(candidate.Name(), orphan, 0); err != nil {
		t.Fatal(err)
	}
	staleTemp := filepath.Join(dir, ".note-image-crashed")
	if err := os.WriteFile(staleTemp, data, 0600); err != nil {
		t.Fatal(err)
	}
	s.Close()
	if err := s.Store.DB.Close(); err != nil {
		t.Fatal(err)
	}
	store, err := OpenLibrary(root)
	if err != nil {
		t.Fatal(err)
	}
	defer store.DB.Close()
	reopened := NewServer(store, "test-secret", "")
	defer reopened.Close()
	requireTestNoteImage(t, reopened, path, data, "image/png")
	for _, removed := range []string{staleTemp, filepath.Join(dir, orphan)} {
		if _, err := os.Stat(removed); !os.IsNotExist(err) {
			t.Fatalf("abandoned file survived recovery: %v", err)
		}
	}
}

func TestNoteImageOpenedBeforePurgeCanFinishReading(t *testing.T) {
	s := testServer(t)
	doc := attachmentPaper(t, s, 1).ID
	data := testNotePNG(t, 11)
	path := addTestNoteImage(t, s, doc, data, "png")
	f, _, err := s.openNoteImage(strings.TrimPrefix(path, "assets/"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.closeAttachmentBlob(f)
	assertNoteImageStatus(t, s, "DELETE", "/api/documents/"+doc, nil, 204)
	assertNoteImageStatus(t, s, "GET", noteImageURL(path), nil, 404)
	got, err := io.ReadAll(f)
	if err != nil || !bytes.Equal(got, data) {
		t.Fatalf("purge invalidated an open read: %v", err)
	}
}
