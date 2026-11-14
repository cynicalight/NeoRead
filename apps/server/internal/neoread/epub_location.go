package neoread

import (
	"encoding/json"
	"strings"
)

// Translation annotations retain original chapter locations for every selected
// paragraph. Validate them at the same boundary as the outer location.
func validEPUBTranslationLocations(data json.RawMessage) bool {
	var outer struct {
		Translation *struct {
			Ranges []struct {
				Location json.RawMessage `json:"location"`
			} `json:"ranges"`
		} `json:"translation"`
	}
	if json.Unmarshal(data, &outer) != nil {
		return false
	}
	if outer.Translation == nil {
		return true
	}
	for _, r := range outer.Translation.Ranges {
		if len(r.Location) == 0 {
			continue
		}
		var source struct {
			Type        string          `json:"type"`
			Href        string          `json:"href"`
			Locator     string          `json:"locator"`
			Progression float64         `json:"progression"`
			Translation json.RawMessage `json:"translation"`
		}
		if json.Unmarshal(r.Location, &source) != nil || source.Type != "epub" || len(source.Translation) > 0 || !validEPUBBlockLocation(r.Location) {
			return false
		}
		if _, err := safeResource(source.Href); err != nil || source.Href == "" || source.Progression < 0 || source.Progression > 1 || !validEPUBLocator(source.Locator, source.Href) {
			return false
		}
	}
	return true
}

func validEPUBBlockLocation(data json.RawMessage) bool {
	var value struct {
		BlockID    *string `json:"blockId"`
		Start      *int    `json:"start"`
		End        *int    `json:"end"`
		EndBlockID *string `json:"endBlockId"`
		Order      *struct {
			Chapter *int `json:"chapter"`
			Block   *int `json:"block"`
		} `json:"order"`
	}
	if json.Unmarshal(data, &value) != nil {
		return false
	}
	if value.Order != nil && (value.Order.Chapter == nil || value.Order.Block == nil || *value.Order.Chapter < 0 || *value.Order.Block < 0) {
		return false
	}
	if value.BlockID == nil {
		return value.Start == nil && value.End == nil && value.EndBlockID == nil
	}
	if strings.TrimSpace(*value.BlockID) == "" {
		return false
	}
	if value.Start == nil || value.End == nil || *value.Start < 0 || *value.End < 0 {
		return false
	}
	if value.EndBlockID != nil {
		return strings.TrimSpace(*value.EndBlockID) != "" && (*value.EndBlockID != *value.BlockID || *value.End >= *value.Start)
	}
	return *value.End >= *value.Start
}
