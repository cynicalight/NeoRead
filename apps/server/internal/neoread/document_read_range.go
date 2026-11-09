package neoread

import (
	"encoding/json"
	"fmt"
)

type documentReadRequest struct {
	Block    string `json:"blockId"`
	Before   int    `json:"before"`
	After    int    `json:"after"`
	Section  string `json:"sectionId"`
	FromPage int    `json:"fromPage"`
	ToPage   int    `json:"toPage"`
	Full     bool   `json:"full"`
	Cursor   string `json:"cursor"`
}

func documentReadIndices(c *documentCorpus, q documentReadRequest) ([]int, bool) {
	selectors := 0
	if q.Block != "" {
		selectors++
	}
	if q.Section != "" {
		selectors++
	}
	if q.FromPage != 0 || q.ToPage != 0 {
		selectors++
	}
	if q.Full {
		selectors++
	}
	if selectors != 1 || q.Before < 0 || q.Before > 3 || q.After < 0 || q.After > 3 {
		return nil, false
	}
	if q.Block != "" {
		if q.Cursor != "" {
			return nil, false
		}
		for i, p := range c.Passages {
			if p.ID == q.Block {
				result := []int{}
				for index := max(0, i-q.Before); index <= min(len(c.Passages)-1, i+q.After); index++ {
					result = append(result, index)
				}
				return result, true
			}
		}
		return nil, false
	}
	if q.Before != 0 || q.After != 0 {
		return nil, false
	}
	if q.FromPage != 0 || q.ToPage != 0 {
		if q.FromPage < 1 || q.ToPage < q.FromPage {
			return nil, false
		}
	}
	indices := []int{}
	foundCursor := q.Cursor == ""
	for i, p := range c.Passages {
		match := q.Full || q.Section != "" && p.Section == q.Section
		if q.FromPage > 0 {
			var location struct {
				Type string `json:"type"`
				Page int    `json:"page"`
			}
			if json.Unmarshal(p.Location, &location) == nil {
				match = location.Type == "pdf" && location.Page >= q.FromPage && location.Page <= q.ToPage
			}
		}
		if !match {
			continue
		}
		if p.ID == q.Cursor {
			foundCursor = true
		}
		if foundCursor {
			indices = append(indices, i)
		}
	}
	return indices, foundCursor && len(indices) > 0
}
func documentReadActivity(c *documentCorpus, q documentReadRequest, indices []int) string {
	p := c.Passages[indices[0]]
	var location struct {
		Type string `json:"type"`
		Page int    `json:"page"`
	}
	_ = json.Unmarshal(p.Location, &location)
	target := "《" + documentActivityLabel(p.Label) + "》"
	if location.Type == "pdf" {
		target = fmt.Sprintf("第 %d 页", location.Page)
	}
	if q.Full {
		if location.Type == "pdf" {
			var last struct {
				Page int `json:"page"`
			}
			_ = json.Unmarshal(c.Passages[indices[len(indices)-1]].Location, &last)
			if location.Page != last.Page {
				target = fmt.Sprintf("第 %d—%d 页", location.Page, last.Page)
			}
			return "正在阅读" + target + " · 顺序阅读全文"
		}
		return "正在阅读" + target + " · 顺序阅读全文"
	}
	if q.FromPage > 0 {
		var last struct {
			Page int `json:"page"`
		}
		_ = json.Unmarshal(c.Passages[indices[len(indices)-1]].Location, &last)
		if location.Page != last.Page {
			target = fmt.Sprintf("第 %d—%d 页", location.Page, last.Page)
		}
		return "正在阅读" + target + " · 阅读连续原文"
	}
	if q.Section != "" {
		return "正在阅读" + target + " · 阅读章节原文"
	}
	purpose := "阅读相关原文"
	if q.Before > 0 || q.After > 0 {
		purpose = "核对原文与相邻段落"
	}
	return "正在查看" + target + " · " + purpose
}
