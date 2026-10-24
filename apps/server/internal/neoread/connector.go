package neoread

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strings"

	nethtml "golang.org/x/net/html"
)

const ConnectorPort = "17841"
const connectorExtensionOrigin = "chrome-extension://afojfnpkeokahhniipldpdpecaljdnbe"
const connectorStoreExtensionOrigin = "chrome-extension://dfhdcomjdkaiajiibbkonbonjlnkdjlg"

// The development build pins its ID with a manifest key; the Chrome Web Store
// build cannot carry that key and is assigned its own ID.
func connectorOriginAllowed(origin string) bool {
	return origin == connectorExtensionOrigin || origin == connectorStoreExtensionOrigin
}

func (s *Server) SetConnectorAvailable(available bool) {
	s.connectorAvailable = available
	s.connectorReason = ""
}

func (s *Server) SetConnectorUnavailable(reason string) {
	s.connectorAvailable = false
	s.connectorReason = reason
}

var snapshotImage = regexp.MustCompile(`^data:image/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$`)

func connectorSetting(db *sql.DB, key string) string {
	var value string
	_ = db.QueryRow("SELECT value FROM settings WHERE key=?", "connector:"+key).Scan(&value)
	return value
}
func connectorSet(db *sql.DB, key, value string) error {
	_, err := db.Exec("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", "connector:"+key, value)
	return err
}
func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return ""
	}
	return hex.EncodeToString(b)
}
func connectorHash(value string) string {
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])
}

func (s *Server) connectorStatus(w http.ResponseWriter, r *http.Request) {
	respond(w, 200, struct {
		Available bool   `json:"available"`
		Reason    string `json:"reason,omitempty"`
	}{s.connectorAvailable, s.connectorReason})
}
func (s *Server) connectorRevisionStatus(w http.ResponseWriter, r *http.Request) {
	respond(w, 200, map[string]int64{"revision": s.connectorRevision.Load()})
}

// ConnectorHandler is deliberately separate from the NeoRead HTTP API. It has
// its own narrow routes, credential, and fixed loopback port for discovery.
func (s *Server) ConnectorHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/status", func(w http.ResponseWriter, r *http.Request) { respond(w, 200, map[string]bool{"running": true}) })
	mux.HandleFunc("POST /v1/session", s.connectorSession)
	mux.HandleFunc("GET /v1/folders", s.connectorFolders)
	mux.HandleFunc("GET /v1/labels", s.connectorLabels)
	mux.HandleFunc("POST /v1/import", s.connectorImport)
	mux.HandleFunc("POST /v1/cite/bootstrap", s.citeBootstrap)
	mux.HandleFunc("POST /v1/cite/execCommand", s.citeExecCommand)
	mux.HandleFunc("POST /v1/cite/respond", s.citeRespond)
	mux.HandleFunc("POST /v1/cite/next", s.citeNext)
	mux.HandleFunc("GET /wps/{key}/{file...}", s.citeWPSFile)
	mux.HandleFunc("GET /wps/{$}", s.citeWPSFile)
	return s.diagnosticHTTP(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, port, err := net.SplitHostPort(r.Host)
		if err != nil || host != "127.0.0.1" || port != ConnectorPort {
			fail(w, 403, "invalid host")
			return
		}
		origin := r.Header.Get("Origin")
		// The WPS add-in page is served from this port and calls it directly.
		sameOrigin := origin == "http://127.0.0.1:"+ConnectorPort && strings.HasPrefix(r.URL.Path, "/v1/cite/")
		if origin != "" && !connectorOriginAllowed(origin) && !sameOrigin {
			fail(w, 403, "invalid origin")
			return
		}
		if origin == "" && (r.URL.Path == "/v1/session" || r.URL.Path == "/v1/status") {
			fail(w, 403, "missing extension origin")
			return
		}
		if origin != "" && !sameOrigin {
			w.Header().Set("Access-Control-Allow-Origin", origin)
		}
		w.Header().Set("Vary", "Origin")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if r.Method == http.MethodOptions {
			w.WriteHeader(204)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/wps/") {
			// The resource handler validates the private installation key.
		} else if r.URL.Path == "/v1/cite/bootstrap" {
			// This handler authenticates with the private installation key.
		} else if strings.HasPrefix(r.URL.Path, "/v1/cite/") {
			// Word macros send no Origin; the plugins read a separate credential.
			if !s.citeAuthorized(r) {
				fail(w, 401, "本机访问凭据已失效，请重启 Reader")
				return
			}
		} else if r.URL.Path != "/v1/session" && r.URL.Path != "/v1/status" {
			savedHash := connectorSetting(s.Store.DB, "secret")
			provided := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
			actualHash := connectorHash(provided)
			if savedHash == "" || subtle.ConstantTimeCompare([]byte(savedHash), []byte(actualHash)) != 1 {
				fail(w, 401, "本机访问凭据已失效")
				return
			}
		}
		mux.ServeHTTP(w, r)
	}))
}
func (s *Server) connectorSession(w http.ResponseWriter, r *http.Request) {
	s.connectorMu.Lock()
	defer s.connectorMu.Unlock()
	secret := randomHex(32)
	if secret == "" {
		fail(w, 500, "无法生成凭据")
		return
	}
	if err := connectorSet(s.Store.DB, "secret", connectorHash(secret)); err != nil {
		fail(w, 500, "无法保存本机访问凭据")
		return
	}
	respond(w, 200, map[string]string{"secret": secret})
}
func (s *Server) connectorFolders(w http.ResponseWriter, r *http.Request) {
	folders, _, err := s.paperLabels()
	if err != nil {
		fail(w, 500, "无法读取分类")
		return
	}
	respond(w, 200, folders)
}
func (s *Server) connectorLabels(w http.ResponseWriter, r *http.Request) {
	folders, tags, err := s.paperLabels()
	if err != nil {
		fail(w, 500, "无法读取论文库分类和标签")
		return
	}
	respond(w, 200, map[string][]string{"folders": folders, "tags": tags})
}
func (s *Server) paperLabels() ([]string, []string, error) {
	var saved string
	err := s.Store.DB.QueryRow("SELECT value FROM settings WHERE key='preferences:library'").Scan(&saved)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, nil, err
	}
	var prefs struct {
		Papers struct {
			Categories []string `json:"categories"`
		} `json:"papers"`
	}
	if saved != "" {
		if err := json.Unmarshal([]byte(saved), &prefs); err != nil {
			return nil, nil, err
		}
	}
	docs, err := s.Store.Documents()
	if err != nil {
		return nil, nil, err
	}
	folders := []string{}
	tags := []string{}
	seenFolders := map[string]bool{}
	seenTags := map[string]bool{}
	addFolder := func(name string) {
		parts := strings.Split(name, "/")
		for i := range parts {
			path := strings.Join(parts[:i+1], "/")
			key := strings.ToLower(path)
			if path != "" && !seenFolders[key] {
				seenFolders[key] = true
				folders = append(folders, path)
			}
		}
	}
	for _, name := range prefs.Papers.Categories {
		addFolder(name)
	}
	extraFolders := []string{}
	extraTags := []string{}
	for _, d := range docs {
		if d.Library == "papers" {
			for _, f := range d.Folders {
				extraFolders = append(extraFolders, f)
			}
			for _, tag := range d.Tags {
				extraTags = append(extraTags, tag)
			}
		}
	}
	sort.Strings(extraFolders)
	for _, name := range extraFolders {
		addFolder(name)
	}
	sort.Strings(extraTags)
	for _, name := range extraTags {
		key := strings.ToLower(name)
		if name != "" && !seenTags[key] {
			seenTags[key] = true
			tags = append(tags, name)
		}
	}
	return folders, tags, nil
}
func (s *Server) connectorImport(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxImportBytes+(11<<20))
	if err := r.ParseMultipartForm(8 << 20); err != nil {
		fail(w, 400, "上传超过限制或内容无效")
		return
	}
	defer r.MultipartForm.RemoveAll()
	file, header, err := r.FormFile("pdf")
	if err != nil {
		fail(w, 400, "请选择 PDF")
		return
	}
	defer file.Close()
	if !strings.HasSuffix(strings.ToLower(header.Filename), ".pdf") {
		fail(w, 400, "仅支持 PDF")
		return
	}
	var fields map[string]json.RawMessage
	if err = json.Unmarshal([]byte(r.FormValue("metadata")), &fields); err != nil {
		fail(w, 400, "论文信息无效")
		return
	}
	titleRaw := fields["title"]
	delete(fields, "title")
	title, err := metadataText(titleRaw, 300, false)
	if err != nil {
		fail(w, 400, "标题无效")
		return
	}
	sourceURL, err := url.Parse(r.FormValue("sourceUrl"))
	if err != nil || !(sourceURL.Scheme == "https" || sourceURL.Scheme == "http") || sourceURL.Host == "" {
		fail(w, 400, "来源链接无效")
		return
	}
	found := PaperMetadata{}
	if err = found.ApplyManual(fields); err != nil {
		fail(w, 400, err.Error())
		return
	}
	found.Sources = nil
	var tags, folders []string
	if raw := r.FormValue("tags"); raw != "" {
		tags, err = normalizeTags(json.RawMessage(raw))
		if err != nil {
			fail(w, 400, "标签无效")
			return
		}
	}
	if raw := r.FormValue("folders"); raw != "" {
		folders, err = normalizeTags(json.RawMessage(raw))
		if err != nil {
			fail(w, 400, "分类无效")
			return
		}
	}
	snapshot := r.FormValue("snapshot")
	if len(snapshot) > 10<<20 {
		fail(w, 400, "网页快照超过 10 MB")
		return
	}
	temp, err := os.CreateTemp(s.Store.Root, "connector-*.pdf")
	if err != nil {
		fail(w, 500, "无法创建临时文件")
		return
	}
	defer os.Remove(temp.Name())
	if _, err = io.Copy(temp, file); err != nil {
		temp.Close()
		fail(w, 500, "无法保存 PDF")
		return
	}
	temp.Close()
	checkFile, err := os.Open(temp.Name())
	if err != nil {
		fail(w, 500, "无法检查 PDF")
		return
	}
	hash := sha256.New()
	_, err = io.Copy(hash, checkFile)
	checkFile.Close()
	if err != nil {
		fail(w, 500, "无法检查 PDF")
		return
	}
	library := r.FormValue("library")
	if library == "" {
		library = "papers"
	}
	if !validLibrary(library) {
		fail(w, 400, "未知书库")
		return
	}
	if existing, lookupErr := s.Store.Document(hex.EncodeToString(hash.Sum(nil))[:32]); lookupErr == nil && existing.Library != library {
		fail(w, 409, "相同 PDF 已在另一个书库，请先在 NeoRead 中移动")
		return
	}
	d, status, err := s.importFile(r.Context(), temp.Name(), "paper.pdf", library, r.FormValue("allowLarge") == "1")
	if err != nil {
		var imp importError
		if errors.As(err, &imp) {
			respond(w, imp.status, map[string]any{"error": imp.message, "code": imp.code, "pages": imp.pages})
		} else {
			fail(w, 500, "导入失败")
		}
		return
	}
	if d.Library != library {
		fail(w, 409, "相同 PDF 已在另一个书库，请先在 NeoRead 中移动")
		return
	}
	d, err = s.applyFound(d.ID, found, title, "connector", "")
	if err != nil {
		fail(w, 500, "论文已保存，但信息更新失败")
		return
	}
	warnings := []string{}
	if len(tags) > 0 || len(folders) > 0 {
		warnings, err = s.mergeConnectorLabels(d.ID, tags, folders)
		if err != nil {
			fail(w, 500, "论文已保存，但分类更新失败")
			return
		}
	}
	if snapshot != "" {
		safe := sanitizeConnectorSnapshot(snapshot, sourceURL)
		_, err = s.Store.DB.Exec("INSERT INTO connector_snapshots(document_id,source_url,body,created_at) VALUES(?,?,?,?) ON CONFLICT(document_id) DO NOTHING", d.ID, sourceURL.String(), safe, now())
		if err != nil {
			fail(w, 500, "论文已保存，但快照保存失败")
			return
		}
	}
	d, _ = s.Store.Document(d.ID)
	s.connectorRevision.Add(1)
	respond(w, status, map[string]any{"document": d, "snapshot": snapshot != "", "warnings": warnings})
}
func mustJSON(v any) json.RawMessage { b, _ := json.Marshal(v); return b }
func mergeConnectorList(existing, incoming []string) ([]string, bool) {
	out := []string{}
	seen := map[string]bool{}
	limited := false
	for _, value := range append(existing, incoming...) {
		key := strings.ToLower(value)
		if seen[key] {
			continue
		}
		seen[key] = true
		if len(out) == 30 {
			limited = true
			continue
		}
		out = append(out, value)
	}
	return out, limited
}
func (s *Server) mergeConnectorLabels(id string, tags, folders []string) ([]string, error) {
	for range 3 {
		var oldTags, oldFolders string
		if err := s.Store.DB.QueryRow("SELECT tags,folders FROM documents WHERE id=?", id).Scan(&oldTags, &oldFolders); err != nil {
			return nil, err
		}
		var currentTags, currentFolders []string
		if json.Unmarshal([]byte(oldTags), &currentTags) != nil || json.Unmarshal([]byte(oldFolders), &currentFolders) != nil {
			return nil, errors.New("invalid stored labels")
		}
		mergedTags, tagLimit := mergeConnectorList(currentTags, tags)
		mergedFolders, folderLimit := mergeConnectorList(currentFolders, folders)
		result, err := s.Store.DB.Exec("UPDATE documents SET tags=?,folders=? WHERE id=? AND tags=? AND folders=?", string(mustJSON(mergedTags)), string(mustJSON(mergedFolders)), id, oldTags, oldFolders)
		if err != nil {
			return nil, err
		}
		if n, _ := result.RowsAffected(); n == 1 {
			warnings := []string{}
			if tagLimit {
				warnings = append(warnings, "标签已达 30 个，部分新标签未加入")
			}
			if folderLimit {
				warnings = append(warnings, "分类已达 30 个，部分新分类未加入")
			}
			return warnings, nil
		}
	}
	return nil, errors.New("labels changed concurrently")
}
func sanitizeConnectorSnapshot(source string, base *url.URL) string {
	root, err := nethtml.Parse(strings.NewReader(source))
	if err != nil {
		return ""
	}
	var b strings.Builder
	b.WriteString(`<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{max-width:780px;margin:40px auto;padding:0 20px;font:17px/1.65 system-ui;color:#222}img{max-width:100%;height:auto}table{border-collapse:collapse}td,th{border:1px solid #aaa;padding:4px}pre{white-space:pre-wrap}</style><body>`)
	allowed := map[string]bool{"article": true, "section": true, "main": true, "header": true, "h1": true, "h2": true, "h3": true, "h4": true, "p": true, "br": true, "blockquote": true, "ul": true, "ol": true, "li": true, "pre": true, "code": true, "strong": true, "em": true, "b": true, "i": true, "table": true, "thead": true, "tbody": true, "tr": true, "th": true, "td": true, "figure": true, "figcaption": true, "a": true, "img": true, "div": true, "span": true, "sup": true, "sub": true}
	blocked := map[string]bool{"script": true, "style": true, "iframe": true, "object": true, "embed": true, "form": true, "svg": true, "math": true, "template": true, "noscript": true}
	var walk func(*nethtml.Node)
	walk = func(n *nethtml.Node) {
		if n.Type == nethtml.TextNode {
			b.WriteString(html.EscapeString(n.Data))
			return
		}
		if n.Type != nethtml.ElementNode && n.Type != nethtml.DocumentNode {
			return
		}
		tag := strings.ToLower(n.Data)
		if blocked[tag] {
			return
		}
		emit := n.Type == nethtml.ElementNode && allowed[tag]
		if emit {
			b.WriteByte('<')
			b.WriteString(tag)
			for _, a := range n.Attr {
				key := strings.ToLower(a.Key)
				value := strings.TrimSpace(a.Val)
				if tag == "a" && key == "href" {
					u, e := url.Parse(value)
					if e == nil {
						u = base.ResolveReference(u)
					}
					if e == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != "" {
						fmt.Fprintf(&b, ` href="%s" rel="noreferrer" target="_blank"`, html.EscapeString(u.String()))
					}
				}
				if tag == "img" && key == "src" && len(value) < 3<<20 && snapshotImage.MatchString(value) {
					fmt.Fprintf(&b, ` src="%s"`, value)
				}
				if tag == "img" && key == "alt" {
					fmt.Fprintf(&b, ` alt="%s"`, html.EscapeString(value))
				}
			}
			b.WriteByte('>')
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
		if emit && tag != "br" && tag != "img" {
			b.WriteString("</")
			b.WriteString(tag)
			b.WriteByte('>')
		}
	}
	for c := root.FirstChild; c != nil; c = c.NextSibling {
		walk(c)
	}
	b.WriteString("</body></html>")
	return b.String()
}
func (s *Server) connectorSnapshot(w http.ResponseWriter, r *http.Request, id string) {
	var body string
	if err := s.Store.DB.QueryRow("SELECT body FROM connector_snapshots WHERE document_id=?", id).Scan(&body); err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox allow-popups")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = io.WriteString(w, body)
}

func (s *Server) connectorSnapshotStatus(w http.ResponseWriter, r *http.Request) {
	var source string
	err := s.Store.DB.QueryRow("SELECT source_url FROM connector_snapshots WHERE document_id=?", r.PathValue("id")).Scan(&source)
	if err != nil {
		respond(w, 200, map[string]any{"available": false})
		return
	}
	respond(w, 200, map[string]any{"available": true, "sourceUrl": source})
}
