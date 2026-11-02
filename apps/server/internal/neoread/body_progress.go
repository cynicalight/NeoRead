package neoread

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// BodyEnd is the beginning of references; y is a normalized page coordinate.
type BodyEnd struct {
	Page int     `json:"page"`
	Y    float64 `json:"y"`
}

var referenceHeading = regexp.MustCompile(`(?i)^\s*(?:[0-9]+[.)]?\s*)?(?:references|bibliography|references\s+and\s+notes|参考文献|引用文献)\s*[:：]?\s*$`)

func layoutBodyEnd(layout layoutManifest) *BodyEnd {
	if layout.Pages < 1 {
		return nil
	}
	if len(layout.ParsedPages) > 0 {
		parsed := make(map[int]bool, len(layout.ParsedPages))
		for _, page := range layout.ParsedPages {
			parsed[page] = true
		}
		for page := 1; page <= layout.Pages; page++ {
			if !parsed[page] {
				return nil
			}
		}
	}
	var heading, reference *BodyEnd
	for _, block := range layout.Blocks {
		if block.Label == "header" || block.Label == "footer" || block.Label == "footnote" {
			continue
		}
		candidate := &BodyEnd{Page: block.Page, Y: block.Bounds.Y}
		earlier := func(end *BodyEnd) bool {
			return end == nil || candidate.Page < end.Page || candidate.Page == end.Page && candidate.Y < end.Y
		}
		if referenceHeading.MatchString(block.Text) && earlier(heading) {
			heading = candidate
		} else if (block.Label == "reference_content" || block.Label == "reference") && earlier(reference) {
			reference = candidate
		}
	}
	if heading != nil {
		return heading
	}
	if reference != nil {
		return reference
	}
	return &BodyEnd{Page: layout.Pages, Y: 1}
}

func (s *Store) saveBodyEnd(id string, layout layoutManifest) error {
	end := layoutBodyEnd(layout)
	if end == nil {
		return nil
	}
	body, err := json.Marshal(end)
	if err != nil {
		return err
	}
	_, err = s.DB.Exec("UPDATE documents SET body_end=? WHERE id=? AND library='papers' AND (body_end IS NULL OR body_end<>?)", string(body), id, string(body))
	return err
}

// Existing translated papers get the new metric from their saved layout.
func (s *Store) refreshBodyEnds() error {
	rows, err := s.DB.Query("SELECT id FROM documents WHERE type='pdf' AND library='papers' AND body_end IS NULL")
	if err != nil {
		return err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, id := range ids {
		if id == "" || id == "." || id == ".." || strings.ContainsAny(id, "/\\") {
			return errors.New("书库文档标识无效")
		}
		layout, e := readValidatedLayout(filepath.Join(s.Root, "cache", id, "analysis", "manifest.json"))
		if os.IsNotExist(e) {
			continue
		}
		if e != nil {
			continue
		} // Existing parsing/recovery owns invalid layouts.
		if err = s.saveBodyEnd(id, layout); err != nil {
			return err
		}
	}
	return nil
}
