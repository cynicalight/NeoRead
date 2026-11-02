package neoread

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"unicode/utf8"
)

// FillFrom copies fields that m lacks from other, keeping their sources.
func (m *PaperMetadata) FillFrom(other PaperMetadata) []string {
	filled := []string{}
	for key := range metadataLabels {
		if m.has(key) || !other.has(key) {
			continue
		}
		source := other.Sources[key]
		if source == "" {
			source = "file"
		}
		if key == "creators" {
			m.set(key, other.Creators, source)
		} else {
			m.set(key, *other.textField(key), source)
		}
		filled = append(filled, key)
	}
	if m.Rating == 0 && other.Rating > 0 {
		m.set("rating", other.Rating, "manual")
		filled = append(filled, "rating")
	}
	return filled
}

var readingRank = map[string]int{"unread": 0, "reading": 1, "done": 2}

type mergeResult struct {
	Document Document `json:"document"`
	// Trashed lists the merged copies now in the trash.
	Trashed []string `json:"trashed"`
}

// mergeDocuments folds duplicates into the document at {id}: tags, folders, star,
// the furthest reading status and missing metadata move over; the longest note wins,
// then the duplicates go to the trash with their files, annotations and chats.
func (s *Server) mergeDocuments(w http.ResponseWriter, r *http.Request) {
	var body struct {
		From []string `json:"from"`
	}
	if !decode(w, r, &body) {
		return
	}
	if len(body.From) == 0 || len(body.From) > 20 {
		fail(w, 400, "请选择 1–20 篇要合并的文档")
		return
	}
	s.importMu.Lock()
	defer s.importMu.Unlock()
	id := r.PathValue("id")
	master, err := s.Store.Document(id)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && master.DeletedAt != "") {
		fail(w, 404, "文档不存在")
		return
	}
	if err != nil {
		fail(w, 500, "无法读取文档")
		return
	}
	others := []Document{}
	seen := map[string]bool{id: true}
	for _, otherID := range body.From {
		if seen[otherID] {
			fail(w, 400, "合并列表重复或包含主版本")
			return
		}
		seen[otherID] = true
		d, err := s.Store.Document(otherID)
		if err != nil || d.DeletedAt != "" {
			fail(w, 404, "要合并的文档不存在")
			return
		}
		if d.Library != master.Library {
			fail(w, 400, "只能合并同一个库中的文档")
			return
		}
		others = append(others, d)
	}

	beforeMeta, _ := json.Marshal(master.Metadata)
	beforeTags, _ := json.Marshal(master.Tags)
	tags := append([]string{}, master.Tags...)
	folders := append([]string{}, master.Folders...)
	favorite := master.Favorite
	status := master.ReadingStatus
	meta := master.Metadata
	for _, d := range others {
		tags = append(tags, d.Tags...)
		folders = append(folders, d.Folders...)
		favorite = favorite || d.Favorite
		if readingRank[d.ReadingStatus] > readingRank[status] {
			status = d.ReadingStatus
		}
		meta.FillFrom(d.Metadata)
	}
	raw, _ := json.Marshal(tags)
	merged, err := normalizeTags(raw)
	if err != nil {
		fail(w, 400, "合并后标签超过 30 个")
		return
	}
	raw, _ = json.Marshal(folders)
	mergedFolders, err := normalizeTags(raw)
	if err != nil {
		fail(w, 400, "合并后分类超过 30 个")
		return
	}
	author := master.Author
	if len(master.Metadata.Creators) == 0 && len(meta.Creators) > 0 {
		author = CreatorNames(meta.Creators)
	}

	note, masterNote := "", ""
	for i, d := range append([]Document{master}, others...) {
		var body string
		err := s.Store.DB.QueryRow("SELECT body FROM document_notes WHERE document_id=?", d.ID).Scan(&body)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			fail(w, 500, "无法读取笔记")
			return
		}
		if i == 0 {
			masterNote = body
		}
		if utf8.RuneCountInString(body) > utf8.RuneCountInString(note) {
			note = body
		}
	}
	if utf8.RuneCountInString(note) > 100000 {
		fail(w, 400, "合并后的论文笔记超过 100000 个字符")
		return
	}

	tx, err := s.Store.DB.Begin()
	if err != nil {
		fail(w, 500, "合并失败")
		return
	}
	defer tx.Rollback()
	tagsJSON, _ := json.Marshal(merged)
	foldersJSON, _ := json.Marshal(mergedFolders)
	metaJSON, _ := json.Marshal(meta)
	fav := 0
	if favorite {
		fav = 1
	}
	result, err := tx.Exec("UPDATE documents SET tags=?,folders=?,favorite=?,reading_status=?,metadata=?,author=? WHERE id=? AND deleted_at='' AND metadata=? AND tags=?",
		string(tagsJSON), string(foldersJSON), fav, status, string(metaJSON), author, id, string(beforeMeta), string(beforeTags))
	if err != nil {
		fail(w, 500, "合并失败")
		return
	}
	if n, _ := result.RowsAffected(); n == 0 {
		fail(w, 409, "文档刚被修改，请重试")
		return
	}
	if note != masterNote {
		if _, err = tx.Exec("INSERT INTO document_notes VALUES(?,?,?) ON CONFLICT(document_id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at", id, note, now()); err != nil {
			fail(w, 500, "合并失败")
			return
		}
	}
	// Links to the duplicates now point at the version kept.
	for _, d := range others {
		// Copy ownership, preserving attachments on a duplicate if it is restored.
		// File bytes remain shared until the last attachment is removed.
		if _, err = tx.Exec(`INSERT OR IGNORE INTO paper_attachments(id,document_id,kind,title,filename,media_type,size,sha256,url,created_at) SELECT lower(hex(randomblob(16))),?,kind,title,filename,media_type,size,sha256,url,created_at FROM paper_attachments WHERE document_id=?`, id, d.ID); err != nil {
			fail(w, 500, "合并附件失败")
			return
		}
		for _, rel := range d.Related {
			if rel == id || seen[rel] {
				continue
			}
			a, b := relationPair(id, rel)
			if _, err = tx.Exec("INSERT OR IGNORE INTO document_relations VALUES(?,?,?)", a, b, now()); err != nil {
				fail(w, 500, "合并失败")
				return
			}
		}
	}
	if err = tx.Commit(); err != nil {
		fail(w, 500, "合并失败")
		return
	}

	trashed := []string{}
	for _, d := range others {
		if _, status, message := s.moveToTrash(r.Context(), d.ID); status != 0 {
			fail(w, status, "已合并论文信息，但未能把重复的文档移到回收站："+message)
			return
		}
		trashed = append(trashed, d.ID)
	}
	if master, err = s.Store.Document(id); err != nil {
		fail(w, 500, "无法读取文档")
		return
	}
	respond(w, 200, mergeResult{master, trashed})
}
