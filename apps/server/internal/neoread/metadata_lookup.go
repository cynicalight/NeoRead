package neoread

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"neoread.local/server/internal/scholar"
)

func (s *Server) scholarClient() *scholar.Client {
	s.scholarMu.Lock()
	defer s.scholarMu.Unlock()
	if s.scholar == nil {
		s.scholar = scholar.New(maxImportBytes)
	}
	// Snapshot preferences per operation; never mutate the shared client in flight.
	client := *s.scholar
	var value string
	if s.Store.DB.QueryRow("SELECT value FROM settings WHERE key='preferences:library'").Scan(&value) == nil {
		var prefs struct {
			CrossrefEmail string `json:"crossrefEmail"`
		}
		if json.Unmarshal([]byte(value), &prefs) == nil {
			client.CrossrefEmail = prefs.CrossrefEmail
		}
	}
	return &client
}

const paperLookupAttempts = 10
const paperLookupInterval = 500 * time.Millisecond

// retryPaperLookup waits between failed external lookups and respects cancellation.
func retryPaperLookup(ctx context.Context, interval time.Duration, lookup func(context.Context) (scholar.Metadata, error)) (scholar.Metadata, int, error) {
	var found scholar.Metadata
	var err error
	for attempt := 1; attempt <= paperLookupAttempts; attempt++ {
		if ctx.Err() != nil {
			return found, attempt - 1, ctx.Err()
		}
		found, err = lookup(ctx)
		if err == nil {
			return found, attempt, nil
		}
		if ctx.Err() != nil {
			return found, attempt, ctx.Err()
		}
		if attempt == paperLookupAttempts {
			return found, attempt, err
		}
		timer := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return found, attempt, ctx.Err()
		case <-timer.C:
		}
	}
	return found, paperLookupAttempts, err
}

func (s *Server) lookupScholar(ctx context.Context, id string, ids scholar.Identifiers) (scholar.Metadata, error) {
	return s.lookupScholarCandidates(ctx, id, []scholar.Identifiers{ids}, false)
}

func (s *Server) lookupScholarCandidates(ctx context.Context, id string, candidates []scholar.Identifiers, requireTitle bool) (scholar.Metadata, error) {
	client := s.scholarClient()
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	found, attempts, err := retryPaperLookup(ctx, paperLookupInterval, func(ctx context.Context) (scholar.Metadata, error) {
		var found scholar.Metadata
		var err error
		for _, ids := range candidates {
			found, err = client.Lookup(ctx, ids)
			if err == nil && (!requireTitle || strings.TrimSpace(found.Title) != "") {
				return found, nil
			}
			if err == nil {
				err = scholar.ErrNotFound
			}
			if ctx.Err() != nil {
				return found, ctx.Err()
			}
		}
		return found, err
	})
	outcome := "success"
	level := slog.LevelInfo
	if err != nil {
		outcome = "failed"
		level = slog.LevelWarn
	}
	s.diagnosticEvent(level, "paper.metadata.lookup", "documentId", id, "outcome", outcome, "attempts", attempts, "maxAttempts", paperLookupAttempts, "intervalMs", 500)
	return found, err
}

func fromScholar(m scholar.Metadata) PaperMetadata {
	out := PaperMetadata{ItemType: m.ItemType, Date: m.Date, Venue: m.Venue, Volume: m.Volume, Issue: m.Issue, Pages: m.Pages, Publisher: m.Publisher, DOI: m.DOI, ArXiv: m.ArXiv, ISBN: m.ISBN, URL: m.URL, Abstract: m.Abstract}
	for _, c := range m.Creators {
		out.Creators = append(out.Creators, Creator{Given: c.Given, Family: c.Family, Name: c.Name})
	}
	return out
}

// applyFound saves validated lookup values. Conditional writes preserve unrelated
// concurrent edits while returned fields use the latest completed lookup.
func (s *Server) applyFound(id string, found PaperMetadata, title, source, lookup string, contexts ...context.Context) (Document, error) {
	ctx := context.Background()
	if len(contexts) > 0 {
		ctx = contexts[0]
	}
	for range 3 {
		d, err := s.Store.Document(id)
		if err != nil {
			return d, err
		}
		if source == "venue-agent" && (d.DeletedAt != "" || d.Library != "papers" || ctx.Err() != nil) {
			return d, ctx.Err()
		}
		before, _ := json.Marshal(d.Metadata)
		m := d.Metadata
		if m.Sources == nil {
			m.Sources = map[string]string{}
		}
		changed := m.Merge(found, source)
		nextTitle := d.Title
		if title = strings.TrimSpace(title); source == "ai" {
			if t, e := cleanText(title, 300, false); e == nil {
				if t == d.Title {
					m.SuggestedTitle = ""
				} else {
					m.SuggestedTitle = t
				}
			}
		} else if title != "" && (source == "lookup" || m.Sources["title"] == "") {
			if t, e := cleanText(title, 300, false); e == nil && t != "" {
				nextTitle, m.Sources["title"] = t, source
			}
		}
		if m.SuggestedTitle == nextTitle {
			m.SuggestedTitle = ""
		}
		author := d.Author
		for _, key := range changed {
			if key == "creators" {
				author = CreatorNames(m.Creators)
			}
		}
		if lookup != "" {
			m.Lookup, m.LookedUpAt = lookup, now()
		}
		after, _ := json.Marshal(m)
		result, err := s.Store.DB.ExecContext(ctx, "UPDATE documents SET title=?,author=?,metadata=? WHERE id=? AND metadata=?", nextTitle, author, string(after), id, string(before))
		if err != nil {
			return d, err
		}
		if n, _ := result.RowsAffected(); n == 1 {
			if nextTitle != d.Title || string(after) != string(before) {
				s.connectorRevision.Add(1)
			}
			return s.Store.Document(id)
		}
	}
	return Document{}, errors.New("论文信息正在被修改，请重试")
}

// firstPagesText returns text from the first two parsed pages, where papers
// print their DOI or arXiv stamp.
func (s *Server) firstPagesText(id string) (string, layoutManifest) {
	m, err := s.readLayout(id)
	if err != nil {
		return "", m
	}
	var b strings.Builder
	for _, block := range m.Blocks {
		if block.Page <= 2 && b.Len() < 12000 {
			b.WriteString(block.Text)
			b.WriteByte('\n')
		}
	}
	return b.String(), m
}

// fileTitle accepts a PDF's own title only when it looks like a real title.
func fileTitle(m layoutManifest) string {
	title, _ := m.Metadata["Title"].(string)
	return usablePaperTitle(title)
}

func usablePaperTitle(title string) string {
	title = strings.Join(strings.Fields(title), " ")
	lower := strings.ToLower(title)
	if len([]rune(title)) < 8 || !strings.Contains(title, " ") {
		return ""
	}
	for _, bad := range []string{"microsoft word", ".doc", ".tex", ".pdf", "untitled", "slide"} {
		if strings.Contains(lower, bad) {
			return ""
		}
	}
	return title
}

var errNoIdentifier = errors.New("没有找到 DOI 或 arXiv 编号，可以在详情中填写后重试")

// lookupDocument is the shared pipeline for manual lookup, imported files and
// resolved links. forceTitle is reserved for explicitly accepting a title.
func (s *Server) lookupDocument(ctx context.Context, id string, forceTitle bool) (result Document, resultErr error) {
	d, err := s.Store.Document(id)
	if err != nil {
		return d, err
	}
	started := time.Now()
	s.diagnosticEvent(slog.LevelInfo, "paper.metadata.pipeline.start", "documentId", id)
	defer func() {
		state, outcome, level := "done", "success", slog.LevelInfo
		switch {
		case ctx.Err() != nil:
			resultErr = ctx.Err()
			outcome = "cancelled"
		case errors.Is(resultErr, errNoIdentifier) || errors.Is(resultErr, scholar.ErrNotFound):
			state, outcome = "notFound", "notFound"
		case resultErr != nil:
			state, outcome, level = "failed", "failed", slog.LevelError
		}
		if ctx.Err() == nil {
			if saved, saveErr := s.applyFound(id, PaperMetadata{}, "", "lookup", state, ctx); saveErr == nil {
				result = saved
			} else {
				resultErr, outcome, level = saveErr, "failed", slog.LevelError
			}
		}
		s.diagnosticEvent(level, "paper.metadata.pipeline.finish", "documentId", id, "outcome", outcome, "durationMs", time.Since(started).Milliseconds())
	}()
	if ctx.Err() != nil {
		return d, ctx.Err()
	}
	text, layout := s.firstPagesText(id)
	quick := quickPaperMetadata{Metadata: layout.Metadata}
	if text != "" {
		quick.Pages = []string{text}
	} else if d.Type == "pdf" {
		extracted, extractErr := s.quickPaperMetadata(ctx, d)
		if extractErr == nil {
			quick = extracted
			s.diagnosticEvent(slog.LevelInfo, "paper.metadata.extract", "documentId", id, "outcome", "success", "pages", len(quick.Pages))
		} else if ctx.Err() == nil {
			s.diagnosticEvent(slog.LevelWarn, "paper.metadata.extract", "documentId", id, "outcome", "failed", "reason", "extract_failed")
		}
	}
	pdfTitle := fileTitle(layoutManifest{Metadata: quick.Metadata})
	ids := scholar.Identifiers{DOI: d.Metadata.DOI, ArXiv: d.Metadata.ArXiv}
	if ids.DOI == "" && ids.ArXiv == "" {
		ids = scholar.Detect(strings.Join(quick.Pages, "\n"))
	}
	var candidates []scholar.Identifiers
	seen := map[scholar.Identifiers]bool{}
	add := func(candidate scholar.Identifiers) {
		if candidate != (scholar.Identifiers{}) && !seen[candidate] {
			seen[candidate] = true
			candidates = append(candidates, candidate)
		}
	}
	if forceTitle {
		add(scholar.Identifiers{Title: d.Title})
	} else {
		if ids.ArXiv != "" {
			add(scholar.Identifiers{ArXiv: ids.ArXiv})
		}
		if ids.DOI != "" {
			add(scholar.Identifiers{DOI: ids.DOI})
		}
		if pdfTitle != "" {
			add(scholar.Identifiers{Title: pdfTitle})
		}
		if usablePaperTitle(d.Title) != "" {
			add(scholar.Identifiers{Title: d.Title})
		}
	}
	var primary scholar.Metadata
	lookupErr := errNoIdentifier
	if len(candidates) > 0 {
		primary, lookupErr = s.lookupScholarCandidates(ctx, id, candidates, true)
	}
	foundPrimary := lookupErr == nil
	titleHint := d.Title
	if foundPrimary {
		if _, err = s.applyFound(id, fromScholar(primary), primary.Title, "lookup", "", ctx); err != nil {
			return d, err
		}
		titleHint = primary.Title
	} else if pdfTitle != "" {
		if _, err = s.applyFound(id, PaperMetadata{}, pdfTitle, "file", "", ctx); err != nil {
			return d, err
		}
		titleHint = pdfTitle
	}
	suggestion := strings.Join(strings.Fields(d.Metadata.SuggestedTitle), " ")
	if !forceTitle && !foundPrimary && pdfTitle == "" && suggestion == "" && ctx.Err() == nil {
		suggestion = s.suggestPaperTitle(ctx, id, quick)
		if suggestion != "" {
			if _, err = s.applyFound(id, PaperMetadata{}, suggestion, "ai", "", ctx); err != nil {
				return d, err
			}
		}
	}
	if suggestion != "" && !strings.EqualFold(suggestion, strings.Join(strings.Fields(d.Title), " ")) && ctx.Err() == nil {
		extra, extraErr := s.lookupScholar(ctx, id, scholar.Identifiers{Title: suggestion})
		outcome := "notFound"
		if extraErr == nil {
			if !foundPrimary || sameScholarPaper(primary, extra) {
				if _, err = s.applyFound(id, fromScholar(extra), extra.Title, "lookup", "", ctx); err != nil {
					return d, err
				}
				titleHint, lookupErr, outcome = extra.Title, nil, "found"
			} else {
				outcome = "mismatch"
			}
		} else if !foundPrimary {
			lookupErr = extraErr
		}
		if !foundPrimary && extraErr != nil {
			titleHint = suggestion
		}
		s.diagnosticEvent(slog.LevelInfo, "paper.title.lookup", "documentId", id, "outcome", outcome)
	}
	return s.finishPaperVenue(ctx, id, lookupErr, titleHint)
}

// Do not combine a suggested-title match with a different identified paper.
func sameScholarPaper(a, b scholar.Metadata) bool {
	if a.ArXiv != "" && b.ArXiv != "" {
		bare := func(value string) string {
			prefix := strings.TrimRight(value, "0123456789")
			if len(prefix) < len(value) && strings.HasSuffix(prefix, "v") {
				return strings.TrimSuffix(prefix, "v")
			}
			return value
		}
		return bare(a.ArXiv) == bare(b.ArXiv)
	}
	if a.DOI != "" && b.DOI != "" {
		return strings.EqualFold(a.DOI, b.DOI)
	}
	return scholar.TitleSimilarity(a.Title, b.Title) >= 0.8
}

func lookupMessage(err error) string {
	var e scholar.Error
	if errors.As(err, &e) {
		return e.Message
	}
	if errors.Is(err, errNoIdentifier) {
		return err.Error()
	}
	return "查找论文信息失败，请检查网络后重试"
}

func (s *Server) lookupMetadata(w http.ResponseWriter, r *http.Request) {
	d, err := s.Store.Document(r.PathValue("id"))
	if err != nil {
		fail(w, 404, "文档不存在")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	d, err = s.lookupDocument(ctx, d.ID, r.URL.Query().Get("by") == "title")
	if err != nil {
		status := 502
		if errors.Is(err, errNoIdentifier) || errors.Is(err, scholar.ErrNotFound) {
			status = 404
		}
		fail(w, status, lookupMessage(err))
		return
	}
	respond(w, 200, d)
}

// resolveDocument imports a paper from an arXiv ID, DOI, link or title.
func (s *Server) resolveDocument(w http.ResponseWriter, r *http.Request) {
	var v struct {
		Ref           string `json:"ref"`
		Library       string `json:"library"`
		AllowLarge    bool   `json:"allowLarge"`
		Folder        string `json:"folder"`
		SmartCategory string `json:"smartCategory"`
	}
	if !decode(w, r, &v) {
		return
	}
	if v.Library == "" {
		v.Library = "papers"
	}
	if !validLibrary(v.Library) {
		fail(w, 400, "未知书库")
		return
	}
	if _, err := s.importCategoryTags(v.Library, v.Folder, v.SmartCategory); err != nil {
		fail(w, 400, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Minute)
	defer cancel()
	result, err := s.scholarClient().Resolve(ctx, v.Ref)
	if err != nil {
		status := 502
		if errors.Is(err, scholar.ErrNotFound) {
			status = 404
		}
		var e scholar.Error
		if errors.As(err, &e) && status == 502 {
			status = 400
		}
		fail(w, status, lookupMessage(err))
		return
	}
	temp, err := os.CreateTemp(s.Store.Root, "import-*")
	if err != nil {
		fail(w, 500, "无法保存文件")
		return
	}
	defer os.Remove(temp.Name())
	_, err = temp.Write(result.PDF)
	if closeErr := temp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		fail(w, 500, "无法保存文件")
		return
	}
	d, status, err := s.importFileToCategory(ctx, temp.Name(), result.Filename, v.Library, v.AllowLarge, v.Folder, v.SmartCategory)
	var imp importError
	if errors.As(err, &imp) && imp.code != "" {
		respond(w, status, map[string]any{"error": imp.message, "code": imp.code, "pages": imp.pages})
		return
	}
	if err != nil {
		fail(w, status, err.Error())
		return
	}
	if d.Library == "papers" {
		if updated, e := s.applyFound(d.ID, fromScholar(result.Metadata), result.Metadata.Title, "lookup", "pending"); e == nil {
			d = updated
		}
	}
	respond(w, status, d)
}

func (s *Server) autoLookupEnabled() bool {
	var value string
	if s.Store.DB.QueryRow("SELECT value FROM settings WHERE key='preferences:library'").Scan(&value) != nil {
		return true
	}
	var prefs struct {
		Papers struct {
			AutoLookup *bool `json:"autoLookup"`
		} `json:"papers"`
	}
	if json.Unmarshal([]byte(value), &prefs) != nil || prefs.Papers.AutoLookup == nil {
		return true
	}
	return *prefs.Papers.AutoLookup
}

// metadataWorker processes pending paper lookups independently of full parsing.
func (s *Server) metadataWorker(ctx context.Context) {
	tick := time.NewTicker(3 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		if !s.autoLookupEnabled() {
			continue
		}
		var id string
		err := s.Store.DB.QueryRow(`SELECT d.id FROM documents d
   WHERE d.library='papers' AND d.deleted_at='' AND json_extract(d.metadata,'$.lookup')='pending'
   ORDER BY d.created_at LIMIT 1`).Scan(&id)
		if errors.Is(err, sql.ErrNoRows) || err != nil {
			continue
		}
		work, finish, err := s.beginDocumentTask(ctx, id)
		if err != nil {
			continue
		}
		lookupCtx, cancel := context.WithTimeout(work, time.Minute)
		_, _ = s.lookupDocument(lookupCtx, id, false)
		cancel()
		finish()
	}
}
