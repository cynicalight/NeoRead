package reader

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/sync/singleflight"

	"reader.local/server/internal/diagnostics"
	"reader.local/server/internal/scholar"
)

type Server struct {
	chatReservations       map[string]bool
	chatMu                 sync.Mutex
	chatRuns               map[string]*chatRun
	Diagnostics            *diagnostics.Store
	connectorMu            sync.Mutex
	connectorAvailable     bool
	connectorReason        string
	connectorRevision      atomic.Int64
	zoteroMu               sync.Mutex
	zoteroScans            map[string]*zoteroScan
	endnoteScans           map[string]*endnoteScan
	annotationCheckLocks   sync.Map
	annotationMu           sync.Mutex
	annotationHistory      []annotationChange
	codexChat              codexChatCache
	documentCodex          documentCodexCache
	corpusMu               sync.Mutex
	overviewMu             sync.Mutex
	overviewActive         map[string]context.CancelFunc
	Store                  *Store
	Token                  string
	Web                    string
	aiMu                   sync.Mutex
	documentMu             sync.Mutex
	documentClosed         bool
	documentTasks          map[string]map[*documentTask]struct{}
	deletingDocuments      map[string]bool
	importMu               sync.Mutex
	configMu               sync.Mutex
	translationMu          sync.Mutex
	translationSubscribers map[string]map[chan TranslationBlock]struct{}
	processingMu           sync.Mutex
	processingControlMu    sync.Mutex
	activeProcessing       map[string]*documentTask
	blockedProcessing      map[string]bool
	modelMu                sync.Mutex
	modelCache             map[string]modelCatalogEntry
	scholarMu              sync.Mutex
	scholar                *scholar.Client
	journalRankMu          sync.Mutex
	journalRankLast        time.Time
	journalRankRequests    singleflight.Group
}

func NewServer(s *Store, token, web string) *Server { return &Server{Store: s, Token: token, Web: web} }
func id() string                                    { b := make([]byte, 16); _, _ = rand.Read(b); return hex.EncodeToString(b) }
func respond(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func fail(w http.ResponseWriter, status int, message string) {
	if out, ok := w.(*diagnosticResponse); ok {
		// UI explanations can contain private titles or bare hostnames.
		out.server.diagnosticEvent(slog.LevelError, "http.failure", "requestId", out.requestID, "status", status, "errorCode", fmt.Sprintf("http_%d", status))
	}
	respond(w, status, map[string]string{"error": message})
}
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		fail(w, 400, "无效的请求内容")
		return false
	}
	return true
}
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/diagnostics/events", s.recordDiagnostic)
	mux.HandleFunc("GET /api/diagnostics/export", s.exportDiagnostics)
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) { respond(w, 200, map[string]string{"status": "ok"}) })
	mux.HandleFunc("GET /api/documents", func(w http.ResponseWriter, r *http.Request) {
		v, e := s.Store.Documents()
		if e != nil {
			s.diagnosticEvent(slog.LevelError, "database.read_failed", "requestId", requestID(r.Context()), "cause", e.Error())
			fail(w, 500, "无法读取书库")
			return
		}
		respond(w, 200, v)
	})
	mux.HandleFunc("GET /api/tag-boards", s.tagBoards)
	mux.HandleFunc("POST /api/tag-boards", s.saveTagBoard)
	mux.HandleFunc("PUT /api/tag-boards/{id}", s.saveTagBoard)
	mux.HandleFunc("DELETE /api/tag-boards/{id}", s.deleteTagBoard)
	mux.HandleFunc("GET /api/import/zotero", s.zoteroDefaults)
	mux.HandleFunc("GET /api/connector/status", s.connectorStatus)
	mux.HandleFunc("GET /api/journal-ranks/config", s.getJournalRankConfig)
	mux.HandleFunc("PUT /api/journal-ranks/config", s.putJournalRankConfig)
	mux.HandleFunc("GET /api/documents/{id}/journal-rank", s.documentJournalRank)
	mux.HandleFunc("GET /api/connector/revision", s.connectorRevisionStatus)
	mux.HandleFunc("GET /api/documents/{id}/snapshot", s.connectorSnapshotStatus)
	mux.HandleFunc("POST /api/import/zotero/scan", s.scanZotero)
	mux.HandleFunc("POST /api/import/endnote/scan", s.scanEndNote)
	mux.HandleFunc("POST /api/import/endnote", s.importEndNote)
	mux.HandleFunc("POST /api/import/zotero", s.importZotero)
	mux.HandleFunc("POST /api/documents", s.importDocument)
	mux.HandleFunc("POST /api/documents/resolve", s.resolveDocument)
	mux.HandleFunc("GET /api/documents/{id}/note", s.documentNote)
	mux.HandleFunc("PUT /api/documents/{id}/note", s.saveDocumentNote)
	mux.HandleFunc("POST /api/documents/{id}/metadata/lookup", s.lookupMetadata)
	mux.HandleFunc("GET /api/processing", s.processingList)
	mux.HandleFunc("POST /api/translate-selection", s.translateSelection)
	mux.HandleFunc("GET /api/overviews", s.listOverviewStatuses)
	mux.HandleFunc("GET /api/documents/{id}/overview", s.getDocumentOverview)
	mux.HandleFunc("POST /api/documents/{id}/overview", s.requestDocumentOverview)
	mux.HandleFunc("DELETE /api/documents/{id}/overview/job", s.cancelDocumentOverview)
	mux.HandleFunc("POST /api/documents/{id}/processing", s.retryProcessing)
	mux.HandleFunc("GET /api/documents/{id}/assistance", s.getAssistance)
	mux.HandleFunc("POST /api/documents/{id}/assistance", s.setAssistance)
	mux.HandleFunc("POST /api/documents/{id}/translations/range", s.requestTranslationRange)
	mux.HandleFunc("POST /api/documents/{id}/translations/chapter", s.requestEPUBTranslationChapter)
	mux.HandleFunc("GET /api/documents/{id}/blocks", s.documentBlocks)
	mux.HandleFunc("GET /api/documents/{id}/epub-blocks", s.epubBlocks)
	mux.HandleFunc("GET /api/documents/{id}/epub-chapters", s.epubChapters)
	mux.HandleFunc("GET /api/documents/{id}/epub-chapter", s.epubChapterHTML)
	mux.HandleFunc("GET /api/documents/{id}/translations", s.documentTranslations)
	mux.HandleFunc("GET /api/documents/{id}/translations/export", s.exportTranslation)
	mux.HandleFunc("POST /api/documents/{id}/translations/export", s.exportTranslation)
	mux.HandleFunc("GET /api/documents/{id}/translations/stream", s.streamTranslations)
	mux.HandleFunc("POST /api/documents/{id}/translations", s.requestTranslation)
	mux.HandleFunc("PATCH /api/documents/{id}", s.updateDocument)
	mux.HandleFunc("DELETE /api/documents/{id}", s.deleteDocument)
	mux.HandleFunc("POST /api/documents/{id}/trash", s.trashDocument)
	mux.HandleFunc("POST /api/documents/{id}/merge", s.mergeDocuments)
	mux.HandleFunc("PUT /api/documents/{id}/related/{other}", s.relateDocuments)
	mux.HandleFunc("DELETE /api/documents/{id}/related/{other}", s.unrelateDocuments)
	mux.HandleFunc("POST /api/documents/{id}/restore", s.restoreDocument)
	mux.HandleFunc("GET /api/trash", s.trashList)
	mux.HandleFunc("DELETE /api/trash", s.emptyTrash)
	mux.HandleFunc("POST /api/documents/{id}/classification", s.retryClassification)
	mux.HandleFunc("POST /api/documents/{id}/annotations/undo", s.undoAnnotation)
	mux.HandleFunc("GET /api/documents/{id}/annotations", s.annotations)
	mux.HandleFunc("POST /api/documents/{id}/annotations/recover", s.recoverAnnotations)
	mux.HandleFunc("POST /api/documents/{id}/annotations", s.recordAnnotation(s.saveAnnotation))
	mux.HandleFunc("PATCH /api/documents/{id}/annotations/{annotation}", s.recordAnnotation(s.updateAnnotationNote))
	mux.HandleFunc("DELETE /api/documents/{id}/annotations/{annotation}", s.recordAnnotation(func(w http.ResponseWriter, r *http.Request) {
		_, err := s.Store.DB.Exec("DELETE FROM annotations WHERE id=? AND document_id=?", r.PathValue("annotation"), r.PathValue("id"))
		if err != nil {
			fail(w, 500, "删除失败")
			return
		}
		w.WriteHeader(204)
	}))
	mux.HandleFunc("GET /api/documents/{id}/search", s.search)
	mux.HandleFunc("GET /api/documents/{id}/text", s.documentText)
	mux.HandleFunc("GET /api/search", s.librarySearch)
	mux.HandleFunc("GET /api/documents/{id}/messages", s.messages)
	mux.HandleFunc("GET /api/documents/{id}/messages/{message}/sources/{source}", s.validateChatEvidence)
	mux.HandleFunc("POST /api/documents/{id}/chat", s.chat)
	mux.HandleFunc("GET /api/documents/{id}/chat-sessions", s.listChatSessions)
	mux.HandleFunc("POST /api/documents/{id}/chat-sessions", s.createChatSession)
	mux.HandleFunc("PATCH /api/documents/{id}/chat-sessions/{session}", s.updateChatSession)
	mux.HandleFunc("GET /api/documents/{id}/chat-sessions/{session}/messages", s.sessionMessages)
	mux.HandleFunc("POST /api/documents/{id}/chat-sessions/{session}/chat", s.chat)
	mux.HandleFunc("GET /api/documents/{id}/chat-sessions/{session}/runs/{run}/events", s.sessionRunEvents)
	mux.HandleFunc("POST /api/documents/{id}/chat-sessions/{session}/runs/{run}/cancel", s.cancelSessionRun)
	mux.HandleFunc("POST /api/documents/{id}/codex-handoff", s.handoffCodex)
	mux.HandleFunc("GET /api/providers", s.providers)
	mux.HandleFunc("GET /api/documents/{id}/processing-usage", s.processingUsage)
	mux.HandleFunc("GET /api/documents/{id}/chat-usage", s.chatUsage)
	mux.HandleFunc("GET /api/ai/config", s.getAIConfig)
	mux.HandleFunc("GET /api/ai/models", s.agentModels)
	mux.HandleFunc("PUT /api/ai/config", s.putAIConfig)
	mux.HandleFunc("POST /api/ai/test/{provider}", s.testConnection)
	mux.HandleFunc("POST /api/libraries/{library}/tags", s.changeLibraryLabels("tags"))
	mux.HandleFunc("POST /api/libraries/{library}/folders", s.changeLibraryLabels("folders"))
	mux.HandleFunc("GET /api/preferences/{key}", s.preferences)
	mux.HandleFunc("PUT /api/preferences/{key}", s.savePreferences)
	mux.HandleFunc("GET /api/settings", func(w http.ResponseWriter, r *http.Request) {
		var value string
		err := s.Store.DB.QueryRow("SELECT value FROM settings WHERE key='reader'").Scan(&value)
		if err != nil {
			respond(w, 200, map[string]any{})
			return
		}
		respond(w, 200, json.RawMessage(value))
	})
	mux.HandleFunc("PUT /api/settings", func(w http.ResponseWriter, r *http.Request) {
		var v map[string]any
		if !decode(w, r, &v) {
			return
		}
		if value, exists := v["documentContextTokens"]; exists {
			n, ok := value.(float64)
			if !ok || (n != 0 && n < 8192) || n > 1048576 || n != float64(int(n)) {
				fail(w, 400, "文档上下文上限须为 0（自动）或 8192—1048576 的整数")
				return
			}
		}
		if value, exists := v["autoGenerateOverview"]; exists {
			if _, ok := value.(bool); !ok {
				fail(w, 400, "自动概要设置必须为布尔值")
				return
			}
		}
		if value, exists := v["autoTranslatePDF"]; exists {
			if _, ok := value.(bool); !ok {
				fail(w, 400, "自动翻译设置必须为布尔值")
				return
			}
		}
		if value, exists := v["autoTranslateMaxPages"]; exists {
			n, ok := value.(float64)
			if !ok || n < 0 || n > 150 || n != float64(int(n)) || int(n)%10 != 0 {
				fail(w, 400, "自动翻译页数须为 0—150 之间的 10 的整数倍")
				return
			}
		}
		b, _ := json.Marshal(v)
		_, err := s.Store.DB.Exec("INSERT INTO settings VALUES('reader',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", string(b))
		if err != nil {
			fail(w, 500, "设置保存失败")
			return
		}
		respond(w, 200, v)
	})
	mux.HandleFunc("GET /pub/{cap}/{id}/{resource...}", s.resource)
	if s.Web != "" {
		mux.Handle("/", webAssets(s.Web))
	}
	return s.diagnosticHTTP(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, err := net.SplitHostPort(r.Host)
		if err != nil {
			host = r.Host
		}
		if host != "127.0.0.1" && host != "localhost" {
			fail(w, 403, "invalid host")
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" {
			u, e := url.Parse(origin)
			if e != nil || u.Scheme != "http" || (u.Host != r.Host && u.Host != "127.0.0.1:5173") {
				fail(w, 403, "invalid origin")
				return
			}
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' blob: 'unsafe-inline'; style-src 'self' blob: 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' data: blob:; frame-src 'self' blob:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'")
		if strings.HasPrefix(r.URL.Path, "/api/") && r.URL.Path != "/api/health" {
			provided := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
			if subtle.ConstantTimeCompare([]byte(provided), []byte(s.Token)) != 1 {
				fail(w, 401, "请使用启动时提供的 Reader 地址")
				return
			}
		}
		mux.ServeHTTP(w, r)
	}))
}

// webAssets serves the built renderer. Chromium only runs an ES module or a
// module worker when the response carries a JavaScript MIME type, and host MIME
// databases map ".mjs" to "text/plain" often enough that Go special-cases ".js"
// alone (golang/go#32350), so the types the bundle depends on are pinned here
// instead of being looked up.
func webAssets(root string) http.Handler {
	files := http.FileServer(http.Dir(root))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if contentType := webContentType(r.URL.Path); contentType != "" {
			w.Header().Set("Content-Type", contentType)
		}
		files.ServeHTTP(w, r)
	})
}
func webContentType(name string) string {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".css":
		return "text/css; charset=utf-8"
	case ".html":
		return "text/html; charset=utf-8"
	case ".js", ".mjs":
		return "text/javascript; charset=utf-8"
	case ".wasm":
		return "application/wasm"
	}
	return ""
}
func (s *Server) importDocument(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxImportBytes+(1<<20))
	if err := r.ParseMultipartForm(8 << 20); err != nil {
		fail(w, 400, "文件超过 512 MB 或上传无效")
		return
	}
	defer r.MultipartForm.RemoveAll()
	library := r.FormValue("library")
	if library == "" {
		library = "books"
	}
	if !validLibrary(library) {
		fail(w, 400, "未知书库")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		fail(w, 400, "请选择 EPUB 或 PDF")
		return
	}
	defer file.Close()
	kind := strings.TrimPrefix(strings.ToLower(filepath.Ext(header.Filename)), ".")
	if kind != "epub" && kind != "pdf" {
		fail(w, 400, "仅支持 EPUB 和 PDF")
		return
	}
	temp, err := os.CreateTemp(s.Store.Root, "import-*")
	if err != nil {
		fail(w, 500, "无法保存文件")
		return
	}
	defer os.Remove(temp.Name())
	defer temp.Close()
	if _, err = io.Copy(temp, file); err != nil {
		fail(w, 400, "上传未完成")
		return
	}
	if err = temp.Close(); err != nil {
		fail(w, 500, "保存失败")
		return
	}
	d, status, err := s.importFileToCategory(r.Context(), temp.Name(), header.Filename, library, r.FormValue("allowLarge") == "1", r.FormValue("folder"), r.FormValue("smartCategory"))
	var large importError
	if errors.As(err, &large) && large.code != "" {
		respond(w, status, map[string]any{"error": large.message, "code": large.code, "pages": large.pages})
		return
	}
	if err != nil {
		fail(w, status, err.Error())
		return
	}
	if status < 300 {
		// Open windows reload the library when the revision changes, so files
		// imported from the command line appear without a restart.
		s.connectorRevision.Add(1)
	}
	respond(w, status, d)
}

type importError struct {
	status  int
	message string
	// code and pages describe a long paper the reader may import as a book.
	code  string
	pages int
}

func (e importError) Error() string { return e.message }

// importFile moves a completed temporary file into the library. An identical
// file returns the existing document, whichever library holds it.
// A long paper is imported only after the reader confirms (allowLarge).
func (s *Server) importFile(ctx context.Context, temp, filename, library string, allowLarge bool) (Document, int, error) {
	return s.importFileToCategory(ctx, temp, filename, library, allowLarge, "", "")
}

func (s *Server) importFileToCategory(ctx context.Context, temp, filename, library string, allowLarge bool, folder, smartCategory string) (Document, int, error) {
	s.importMu.Lock()
	defer s.importMu.Unlock()
	kind := strings.TrimPrefix(strings.ToLower(filepath.Ext(filename)), ".")
	failure := func(status int, message string) (Document, int, error) {
		return Document{}, status, importError{status: status, message: message}
	}
	tags, categoryErr := s.importCategoryTags(library, folder, smartCategory)
	if categoryErr != nil {
		return failure(400, categoryErr.Error())
	}
	f, err := os.Open(temp)
	if err != nil {
		return failure(500, "无法验证文件")
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return failure(500, "无法验证文件大小")
	}
	if info.Size() > maxImportBytes {
		f.Close()
		return failure(400, "文件超过 512 MB")
	}
	hash := sha256.New()
	size, err := io.Copy(hash, f)
	f.Close()
	if err != nil {
		return failure(500, "无法验证文件")
	}
	docID := hex.EncodeToString(hash.Sum(nil))[:32]
	if d, e := s.Store.Document(docID); e == nil {
		// Importing a file again brings it back from the trash.
		if d, err = s.restore(docID); err != nil {
			return failure(500, "无法恢复回收站中的文档")
		}
		if err = s.Store.enqueueDocument(d); err != nil {
			return failure(500, "无法创建解析任务")
		}
		return d, 200, nil
	}
	if kind == "pdf" {
		f, e := os.Open(temp)
		if e != nil {
			return failure(500, "无法验证文件")
		}
		head := make([]byte, 5)
		_, e = io.ReadFull(f, head)
		f.Close()
		if e != nil || string(head) != "%PDF-" {
			return failure(400, "文件不是有效的 PDF")
		}
	}
	if library == "papers" {
		if reason := paperLimit(kind, size, temp); reason != "" {
			return failure(400, reason)
		}
		pages, _ := pdfPageCount(temp)
		if (pages > largePaperPages || size > largePaperBytes) && !allowLarge {
			return Document{}, 409, importError{409, "检测到 PDF 过大，请确认是否是论文？如果是图书类，请导入图书库。", "large-paper", pages}
		}
	}
	d := Document{ID: docID, Type: kind, Title: strings.TrimSuffix(filepath.Base(filename), filepath.Ext(filename)), Size: size, CreatedAt: now(), LastOpenedAt: "", Library: library}
	d.Category, d.CategorySource, d.ClassificationStatus, d.Tags, d.Folders = "article", "default", "pending", tags, []string{}
	if kind == "pdf" && library == "books" {
		// Classification reads parsed text, which books gain chapter by chapter.
		d.ClassificationStatus = "idle"
	}
	if kind == "epub" {
		d.Category = "book"
	}
	if library == "papers" {
		// The library choice is the user's classification; no AI guess is needed.
		d.Category, d.CategorySource, d.ClassificationStatus = "paper", "manual", "done"
		if folder != "" {
			d.Folders = []string{folder}
		}
	}
	var texts map[string]string
	cache := filepath.Join(s.Store.Root, "cache", docID)
	success := false
	defer func() {
		if !success {
			_ = os.RemoveAll(cache)
		}
	}()
	if kind == "epub" {
		m, t, e := prepareEPUB(ctx, temp, cache)
		if e != nil {
			return failure(400, "EPUB 无法导入："+e.Error())
		}
		texts = t
		if metadata, ok := m["metadata"].(map[string]any); ok {
			if title, ok := metadata["title"].(string); ok && title != "" {
				d.Title = title
			}
			if authors, ok := metadata["author"].([]any); ok {
				names := []string{}
				for _, a := range authors {
					if author, ok := a.(map[string]any); ok {
						if n, ok := author["name"].(string); ok {
							names = append(names, n)
						}
					}
				}
				d.Author = strings.Join(names, ", ")
			}
		}
	}
	dest := s.Store.File(d)
	if err = os.Rename(temp, dest); err != nil {
		return failure(500, "无法保存原文件")
	}
	tx, err := s.Store.DB.Begin()
	if err != nil {
		_ = os.Remove(dest)
		return failure(500, "无法写入书库")
	}
	defer tx.Rollback()
	metadata := "{}"
	if library == "papers" {
		// Papers imported from files look up their metadata once parsed.
		metadata = `{"lookup":"pending"}`
	}
	folders, _ := json.Marshal(d.Folders)
	tagJSON, _ := json.Marshal(d.Tags)
	_, err = tx.Exec("INSERT INTO documents(id,type,title,author,size,created_at,last_opened_at,category,category_source,classification_status,library,metadata,folders,tags) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", d.ID, d.Type, d.Title, d.Author, d.Size, d.CreatedAt, d.LastOpenedAt, d.Category, d.CategorySource, d.ClassificationStatus, d.Library, metadata, string(folders), string(tagJSON))
	if err == nil {
		for href, text := range texts {
			_, err = tx.Exec("INSERT INTO search_index(document_id,href,content) VALUES(?,?,?)", d.ID, href, text)
			if err != nil {
				break
			}
		}
	}
	if err == nil {
		var settings string
		_ = tx.QueryRow("SELECT value FROM settings WHERE key='reader'").Scan(&settings)
		p := initialDocumentProcessing(d, settings)
		b, _ := json.Marshal(p)
		_, err = tx.Exec("INSERT INTO document_processing(document_id,phase,status,body) VALUES(?,?,?,?)", d.ID, p.Phase, p.Status, b)
		if err == nil {
			err = queueImportedOverview(tx, d.ID, settings)
		}
	}
	if err == nil {
		_, err = tx.Exec("INSERT INTO document_corpus_jobs(document_id,status) VALUES(?,'queued')", d.ID)
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		_ = os.Remove(dest)
		return failure(500, "书库保存失败")
	}
	success = true
	if saved, e := s.Store.Document(d.ID); e == nil {
		d = saved
	}
	return d, 201, nil
}
func validLocation(data json.RawMessage, kind string) bool {
	var l struct {
		Type        string  `json:"type"`
		Page        int     `json:"page"`
		Href        string  `json:"href"`
		Locator     string  `json:"locator"`
		Progression float64 `json:"progression"`
	}
	if json.Unmarshal(data, &l) != nil || l.Type != kind {
		return false
	}
	if kind == "pdf" {
		return l.Page > 0
	}
	_, err := safeResource(l.Href)
	return l.Href != "" && err == nil && l.Progression >= 0 && l.Progression <= 1 && validEPUBLocator(l.Locator, l.Href) && validEPUBTranslationLocations(data) && validEPUBBlockLocation(data)
}
func (s *Server) updateDocument(w http.ResponseWriter, r *http.Request) {
	d, err := s.Store.Document(r.PathValue("id"))
	if err != nil {
		fail(w, 404, "文档不存在")
		return
	}
	var v struct {
		Title      json.RawMessage            `json:"title"`
		Author     json.RawMessage            `json:"author"`
		Category   json.RawMessage            `json:"category"`
		Tags       json.RawMessage            `json:"tags"`
		Folders    json.RawMessage            `json:"folders"`
		Favorite   *bool                      `json:"favorite"`
		Progress   json.RawMessage            `json:"progress"`
		Percentage *float64                   `json:"percentage"`
		Library    *string                    `json:"library"`
		Metadata   map[string]json.RawMessage `json:"metadata"`
		Status     *string                    `json:"readingStatus"`
	}
	if !decode(w, r, &v) {
		return
	}
	var title, author, category, tags, folders, library, metadata, status any
	if v.Title != nil {
		title, err = metadataText(v.Title, 300, false)
		if err != nil {
			fail(w, 400, "标题须为 1–300 个字符，不能包含控制字符")
			return
		}
	}
	if v.Author != nil {
		author, err = metadataText(v.Author, 200, true)
		if err != nil {
			fail(w, 400, "作者最多 200 个字符，不能包含控制字符")
			return
		}
	}
	if v.Metadata != nil || v.Title != nil {
		m := d.Metadata
		if err = m.ApplyManual(v.Metadata); err != nil {
			fail(w, 400, err.Error())
			return
		}
		if v.Title != nil {
			if m.Sources == nil {
				m.Sources = map[string]string{}
			}
			m.Sources["title"] = "manual"
		}
		if _, ok := v.Metadata["creators"]; ok && v.Author == nil {
			author = CreatorNames(m.Creators)
		}
		b, _ := json.Marshal(m)
		metadata = string(b)
	}
	if v.Status != nil {
		if !validReadingStatus(*v.Status) {
			fail(w, 400, "阅读状态须为未读、在读或已读")
			return
		}
		status = *v.Status
	} else if v.Percentage != nil && *v.Percentage > 0 && d.ReadingStatus == "unread" {
		// Reading starts on the first progress; finishing stays a user decision.
		status = "reading"
	}
	if v.Category != nil {
		var c string
		if json.Unmarshal(v.Category, &c) != nil || !validCategory(c) {
			fail(w, 400, "类型必须为书籍、文章或论文")
			return
		}
		category = c
	}
	if v.Tags != nil {
		normalized, e := normalizeTags(v.Tags)
		if e != nil {
			fail(w, 400, e.Error())
			return
		}
		b, _ := json.Marshal(normalized)
		tags = string(b)
	}
	if v.Folders != nil {
		normalized, e := normalizeTags(v.Folders)
		if e != nil {
			fail(w, 400, "分类必须为数组，最多 30 个，每个 1–40 个字符")
			return
		}
		b, _ := json.Marshal(normalized)
		folders = string(b)
	}
	if v.Library != nil {
		if !validLibrary(*v.Library) {
			fail(w, 400, "未知书库")
			return
		}
		if *v.Library == "papers" && d.Library != "papers" {
			if reason := paperLimit(d.Type, d.Size, s.Store.File(d)); reason != "" {
				fail(w, 400, reason)
				return
			}
			// Moving into the paper library is an explicit classification.
			if category == nil {
				category = "paper"
			}
			if metadata == nil && d.Metadata.Lookup == "" {
				m := d.Metadata
				m.Lookup = "pending"
				b, _ := json.Marshal(m)
				metadata = string(b)
			}
		}
		library = *v.Library
	}
	if v.Progress != nil {
		if !validLocation(v.Progress, d.Type) {
			fail(w, 400, "无效阅读位置")
			return
		}
		d.Progress = v.Progress
	}
	if v.Percentage != nil {
		if *v.Percentage < 0 || *v.Percentage > 1 {
			fail(w, 400, "无效进度")
			return
		}
		d.Percentage = *v.Percentage
	}
	if v.Favorite != nil {
		d.Favorite = *v.Favorite
	}
	var openedAt any
	// Organization and favorites must not move a document into recent reading.
	if v.Progress != nil || v.Percentage != nil || (v.Favorite == nil && v.Category == nil && v.Tags == nil && v.Folders == nil && v.Title == nil && v.Author == nil && v.Library == nil && v.Metadata == nil && v.Status == nil) {
		openedAt = now()
	}
	var progress any
	if v.Progress != nil {
		progress = string(v.Progress)
	}
	_, err = s.Store.DB.Exec("UPDATE documents SET title=COALESCE(?,title),author=COALESCE(?,author),favorite=COALESCE(?,favorite),progress=COALESCE(?,progress),percentage=COALESCE(?,percentage),last_opened_at=COALESCE(?,last_opened_at),category=COALESCE(?,category),tags=COALESCE(?,tags),folders=COALESCE(?,folders),library=COALESCE(?,library),metadata=COALESCE(?,metadata),reading_status=COALESCE(?,reading_status),category_source=CASE WHEN ? IS NOT NULL THEN 'manual' ELSE category_source END,classification_status=CASE WHEN ? IS NOT NULL THEN 'done' ELSE classification_status END,classification_error=CASE WHEN ? IS NOT NULL THEN '' ELSE classification_error END WHERE id=?", title, author, v.Favorite, progress, v.Percentage, openedAt, category, tags, folders, library, metadata, status, category, category, category, d.ID)
	if err != nil {
		fail(w, 500, "保存失败")
		return
	}
	d, err = s.Store.Document(d.ID)
	if err != nil {
		fail(w, 500, "无法读取文档")
		return
	}
	respond(w, 200, d)
}
func (s *Server) annotations(w http.ResponseWriter, r *http.Request) {
	rows, err := s.Store.DB.Query("SELECT body FROM annotations WHERE document_id=? ORDER BY rowid", r.PathValue("id"))
	if err != nil {
		fail(w, 500, "无法读取批注")
		return
	}
	defer rows.Close()
	items := []json.RawMessage{}
	for rows.Next() {
		var b string
		if err = rows.Scan(&b); err != nil {
			fail(w, 500, "无法读取批注")
			return
		}
		items = append(items, json.RawMessage(b))
	}
	respond(w, 200, items)
}
func (s *Server) saveAnnotation(w http.ResponseWriter, r *http.Request) {
	d, err := s.Store.Document(r.PathValue("id"))
	if err != nil {
		fail(w, 404, "文档不存在")
		return
	}
	var a Annotation
	if !decode(w, r, &a) {
		return
	}
	if !validLocation(a.Location, d.Type) || (a.Kind != "highlight" && a.Kind != "underline" && a.Kind != "note" && a.Kind != "question" && a.Kind != "bookmark") {
		fail(w, 400, "批注类型或位置无效")
		return
	}
	a.ID = id()
	a.DocumentID = d.ID
	a.CreatedAt = now()
	a.AnswerID, a.Resolved = "", false
	if m, e := s.readTranslationSource(d.ID); e == nil {
		if translations, e := s.visibleTranslations(d.ID, m); e == nil {
			a = enrichTranslationAnnotation(a, translations)
		}
	}
	result, err := s.Store.saveAnnotation(a)
	if err != nil {
		fail(w, 500, "批注保存失败")
		return
	}
	respond(w, 201, result)
}
func (s *Server) resource(w http.ResponseWriter, r *http.Request) {
	if subtle.ConstantTimeCompare([]byte(r.PathValue("cap")), []byte(s.Token)) != 1 {
		fail(w, 403, "invalid capability")
		return
	}
	d, err := s.Store.Document(r.PathValue("id"))
	if err != nil {
		fail(w, 404, "文档不存在")
		return
	}
	name := r.PathValue("resource")
	if d.Type == "pdf" {
		if name == "snapshot.html" {
			s.connectorSnapshot(w, r, d.ID)
			return
		}
		if strings.HasPrefix(name, "assets/") && strings.HasSuffix(name, ".png") {
			blockID := strings.TrimSuffix(strings.TrimPrefix(name, "assets/"), ".png")
			s.blockImage(w, r, d.ID, blockID)
			return
		}
		if name != "original.pdf" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/pdf")
		http.ServeFile(w, r, s.Store.File(d))
		return
	}
	name, err = safeResource(name)
	if err != nil {
		fail(w, 400, "无效资源路径")
		return
	}
	cache := filepath.Join(s.Store.Root, "cache", d.ID)
	if name == "manifest.json" {
		data, e := os.ReadFile(filepath.Join(cache, name))
		if e != nil {
			fail(w, 404, "目录不可用")
			return
		}
		var m map[string]any
		_ = json.Unmarshal(data, &m)
		m["links"] = []map[string]string{{"rel": "self", "href": "http://" + r.Host + r.URL.Path, "type": "application/webpub+json"}, {"rel": "http://readium.org/positions", "href": "positions.json", "type": "application/vnd.readium.position-list+json"}}
		respond(w, 200, m)
		return
	}
	if name == "positions.json" {
		data, err := os.ReadFile(filepath.Join(cache, name))
		var list struct {
			Positions []json.RawMessage `json:"positions"`
		}
		if err != nil || json.Unmarshal(data, &list) != nil || len(list.Positions) == 0 {
			fail(w, 404, "EPUB 阅读位置不可用")
			return
		}
		// Older caches omitted total, which Readium requires to load positions.
		respond(w, 200, map[string]any{"total": len(list.Positions), "positions": list.Positions})
		return
	}
	ext := strings.ToLower(filepath.Ext(name))
	if ext == ".js" {
		http.NotFound(w, r)
		return
	}
	ct := mime.TypeByExtension(ext)
	if ext == ".xhtml" {
		ct = "text/html; charset=utf-8"
	}
	if ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	http.ServeFile(w, r, filepath.Join(cache, filepath.FromSlash(name)))
}
func (s *Server) search(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		respond(w, 200, []any{})
		return
	}
	query := "\"" + strings.ReplaceAll(q, "\"", "\"\"") + "\""
	rows, err := s.Store.DB.Query("SELECT href,content FROM search_index WHERE document_id=? AND (search_index MATCH ?) LIMIT 100", r.PathValue("id"), query)
	if err != nil {
		fail(w, 500, "搜索失败")
		return
	}
	type hit struct{ href, text string }
	hits := []hit{}
	seen := map[string]bool{}
	for rows.Next() {
		var h hit
		if rows.Scan(&h.href, &h.text) == nil {
			hits = append(hits, h)
			seen[h.href] = true
		}
	}
	rows.Close()
	// unicode61 does not segment CJK words. A literal substring fallback also
	// supports short Chinese queries; percent and underscore are escaped.
	literal := strings.NewReplacer("\\", "\\\\", "%", "\\%", "_", "\\_").Replace(q)
	rows, err = s.Store.DB.Query("SELECT href,content FROM search_index WHERE document_id=? AND content LIKE ? ESCAPE '\\' LIMIT 100", r.PathValue("id"), "%"+literal+"%")
	if err != nil {
		fail(w, 500, "搜索失败")
		return
	}
	defer rows.Close()
	for rows.Next() {
		var h hit
		if rows.Scan(&h.href, &h.text) == nil && !seen[h.href] {
			hits = append(hits, h)
		}
	}
	out := []any{}
	for _, h := range hits {
		runes := []rune(h.text)
		lower := strings.ToLower(h.text)
		index := strings.Index(lower, strings.ToLower(q))
		start := 0
		if index >= 0 {
			start = len([]rune(lower[:index])) - 35
		}
		if start < 0 {
			start = 0
		}
		end := min(len(runes), start+150)
		excerpt := string(runes[start:end])
		out = append(out, map[string]any{"id": h.href, "excerpt": excerpt, "location": map[string]any{"type": "epub", "href": h.href, "quote": q}})
		if len(out) == 100 {
			break
		}
	}
	respond(w, 200, out)
}
func (s *Server) messages(w http.ResponseWriter, r *http.Request) {
	var defaultID string
	if s.Store.DB.QueryRow("SELECT id FROM chat_sessions WHERE document_id=? ORDER BY rowid LIMIT 1", r.PathValue("id")).Scan(&defaultID) == nil {
		r.SetPathValue("session", defaultID)
		s.sessionMessages(w, r)
		return
	}
	rows, err := s.Store.DB.Query("SELECT body FROM messages WHERE document_id=? ORDER BY created_at", r.PathValue("id"))
	if err != nil {
		fail(w, 500, "读取对话失败")
		return
	}
	defer rows.Close()
	out := []json.RawMessage{}
	for rows.Next() {
		var b string
		if rows.Scan(&b) == nil {
			out = append(out, json.RawMessage(b))
		}
	}
	respond(w, 200, out)
}
func (s *Store) saveMessage(m Message) error {
	if m.ID == "" {
		m.ID = id()
	}
	m.CreatedAt = now()
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	_, err = s.DB.Exec("INSERT INTO messages VALUES(?,?,?,?)", m.ID, m.DocumentID, string(b), m.CreatedAt)
	return err
}
