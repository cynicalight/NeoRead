package neoread

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Creator follows CSL-JSON: Latin names split into given/family, others keep one name.
type Creator struct {
	Given  string `json:"given,omitempty"`
	Family string `json:"family,omitempty"`
	Name   string `json:"name,omitempty"`
}

// PaperMetadata is bibliographic data. Sources records where each field came
// from ("file", "lookup" or "manual"); lookups never replace manual values.
type PaperMetadata struct {
	ItemType        string    `json:"itemType,omitempty"`
	SuggestedTitle  string    `json:"suggestedTitle,omitempty"`
	TranslatedTitle string    `json:"translatedTitle,omitempty"`
	ShortTitle      string    `json:"shortTitle,omitempty"`
	Creators        []Creator `json:"creators,omitempty"`
	Affiliation     string    `json:"affiliation,omitempty"`
	Date            string    `json:"date,omitempty"`
	Venue           string    `json:"venue,omitempty"`
	Volume          string    `json:"volume,omitempty"`
	Issue           string    `json:"issue,omitempty"`
	Pages           string    `json:"pages,omitempty"`
	Publisher       string    `json:"publisher,omitempty"`
	DOI             string    `json:"doi,omitempty"`
	ArXiv           string    `json:"arxiv,omitempty"`
	ISBN            string    `json:"isbn,omitempty"`
	URL             string    `json:"url,omitempty"`
	Abstract        string    `json:"abstract,omitempty"`
	Language        string    `json:"language,omitempty"`
	// Remark is the reader's own note on the item, never looked up.
	Remark string `json:"remark,omitempty"`
	// Rating is the reader's own 1–5 star score; 0 means unrated.
	Rating  int               `json:"rating,omitempty"`
	Sources map[string]string `json:"sources,omitempty"`
	// Lookup is "pending" until the automatic lookup ran, then "done",
	// "notFound" or "failed".
	Lookup     string `json:"lookup,omitempty"`
	LookedUpAt string `json:"lookedUpAt,omitempty"`
}

var itemTypes = map[string]bool{"journal": true, "conference": true, "preprint": true, "thesis": true, "book": true, "chapter": true, "report": true, "other": true}

var (
	doiPattern   = regexp.MustCompile(`^10\.\d{4,9}/\S+$`)
	arxivPattern = regexp.MustCompile(`^(\d{4}\.\d{4,5}|[a-z\-]+(\.[A-Z]{2})?/\d{7})(v\d+)?$`)
	datePattern  = regexp.MustCompile(`^\d{4}(-\d{2}(-\d{2})?)?$`)
	isbnPattern  = regexp.MustCompile(`^[0-9X\-]{10,17}$`)
)

// NormalizeDOI accepts bare DOIs, doi: prefixes and doi.org links.
func NormalizeDOI(value string) string {
	value = strings.TrimSpace(value)
	lower := strings.ToLower(value)
	for _, prefix := range []string{"https://doi.org/", "http://doi.org/", "https://dx.doi.org/", "http://dx.doi.org/", "doi.org/", "doi:"} {
		if strings.HasPrefix(lower, prefix) {
			value = strings.TrimSpace(value[len(prefix):])
			break
		}
	}
	if decoded, err := url.PathUnescape(value); err == nil {
		value = decoded
	}
	return strings.TrimRight(value, ".,;")
}

// NormalizeArXiv accepts IDs, arXiv: prefixes and abs/pdf links.
func NormalizeArXiv(value string) string {
	value = strings.TrimSpace(value)
	lower := strings.ToLower(value)
	if i := strings.Index(lower, "arxiv.org/"); i >= 0 {
		value = value[i+len("arxiv.org/"):]
		for _, prefix := range []string{"abs/", "pdf/", "html/"} {
			if strings.HasPrefix(value, prefix) {
				value = value[len(prefix):]
			}
		}
		value = strings.TrimSuffix(strings.SplitN(value, "?", 2)[0], ".pdf")
	}
	if strings.HasPrefix(strings.ToLower(value), "arxiv:") {
		value = strings.TrimSpace(value[len("arxiv:"):])
	}
	return value
}

func cleanText(value string, limit int, multiline bool) (string, error) {
	value = strings.TrimSpace(value)
	if utf8.RuneCountInString(value) > limit {
		return "", fmt.Errorf("最多 %d 个字符", limit)
	}
	if strings.ContainsFunc(value, func(r rune) bool {
		return unicode.IsControl(r) && !(multiline && (r == '\n' || r == '\t'))
	}) {
		return "", errors.New("不能包含控制字符")
	}
	return value, nil
}

var metadataLabels = map[string]string{
	"itemType": "论文类型", "translatedTitle": "译名", "shortTitle": "短标题", "creators": "作者", "affiliation": "单位",
	"date": "日期", "venue": "出处", "volume": "卷", "issue": "期", "pages": "页码", "publisher": "出版者",
	"doi": "DOI", "arxiv": "arXiv 编号", "isbn": "ISBN", "url": "链接", "abstract": "摘要", "language": "语言",
	"remark": "备注",
}

// normalizeMetadataField validates one field and returns its canonical value.
func normalizeMetadataField(key string, raw json.RawMessage) (any, error) {
	if key == "rating" {
		var rating int
		if json.Unmarshal(raw, &rating) != nil || rating < 0 || rating > 5 {
			return nil, errors.New("评分须为 0–5 的整数")
		}
		return rating, nil
	}
	label := metadataLabels[key]
	if label == "" {
		return nil, fmt.Errorf("未知论文字段：%s", key)
	}
	if key == "creators" {
		var creators []Creator
		if json.Unmarshal(raw, &creators) != nil || len(creators) > 200 {
			return nil, errors.New("作者格式无效")
		}
		out := []Creator{}
		for _, c := range creators {
			var err error
			for _, part := range []*string{&c.Given, &c.Family, &c.Name} {
				if *part, err = cleanText(*part, 200, false); err != nil {
					return nil, fmt.Errorf("作者%s", err.Error())
				}
			}
			if c.Given != "" && c.Family == "" && c.Name == "" {
				c.Name, c.Given = c.Given, ""
			}
			if c.Family != "" || c.Name != "" {
				out = append(out, c)
			}
		}
		return out, nil
	}
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return nil, fmt.Errorf("%s须为文本", label)
	}
	limit := 500
	if key == "abstract" || key == "remark" {
		limit = 20000
	}
	value, err := cleanText(value, limit, key == "abstract" || key == "remark")
	if err != nil {
		return nil, fmt.Errorf("%s%s", label, err.Error())
	}
	if value == "" {
		return value, nil
	}
	switch key {
	case "itemType":
		if !itemTypes[value] {
			return nil, errors.New("未知论文类型")
		}
	case "doi":
		if value = NormalizeDOI(value); !doiPattern.MatchString(value) {
			return nil, errors.New("DOI 格式不正确，请填写 10. 开头的编号或 doi.org 链接")
		}
	case "arxiv":
		if value = NormalizeArXiv(value); !arxivPattern.MatchString(value) {
			return nil, errors.New("arXiv 编号格式不正确，例如 2401.01234")
		}
	case "date":
		if !datePattern.MatchString(value) {
			return nil, errors.New("日期格式为 2024、2024-05 或 2024-05-17")
		}
	case "isbn":
		if !isbnPattern.MatchString(strings.ReplaceAll(value, " ", "")) {
			return nil, errors.New("ISBN 格式不正确")
		}
	case "url":
		u, e := url.Parse(value)
		if e != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return nil, errors.New("链接须为 http 或 https 地址")
		}
	}
	return value, nil
}

func (m *PaperMetadata) textField(key string) *string {
	return map[string]*string{
		"itemType": &m.ItemType, "translatedTitle": &m.TranslatedTitle, "shortTitle": &m.ShortTitle, "affiliation": &m.Affiliation,
		"date": &m.Date, "venue": &m.Venue, "volume": &m.Volume, "issue": &m.Issue, "pages": &m.Pages, "publisher": &m.Publisher,
		"doi": &m.DOI, "arxiv": &m.ArXiv, "isbn": &m.ISBN, "url": &m.URL, "abstract": &m.Abstract, "language": &m.Language, "remark": &m.Remark,
	}[key]
}

// set stores a validated value and records its source.
func (m *PaperMetadata) set(key string, value any, source string) {
	switch key {
	case "creators":
		m.Creators = value.([]Creator)
	case "rating":
		m.Rating = value.(int)
	default:
		*m.textField(key) = value.(string)
	}
	if m.Sources == nil {
		m.Sources = map[string]string{}
	}
	m.Sources[key] = source
}

// ApplyManual validates every field before changing any.
func (m *PaperMetadata) ApplyManual(patch map[string]json.RawMessage) error {
	values := map[string]any{}
	for key, raw := range patch {
		if key == "suggestedTitle" {
			var value string
			if json.Unmarshal(raw, &value) != nil {
				return errors.New("建议标题须为文本")
			}
			value, err := cleanText(value, 300, false)
			if err != nil {
				return err
			}
			values[key] = value
			continue
		}
		value, err := normalizeMetadataField(key, raw)
		if err != nil {
			return err
		}
		values[key] = value
	}
	for key, value := range values {
		if key == "suggestedTitle" {
			m.SuggestedTitle = value.(string)
			continue
		}
		m.set(key, value, "manual")
	}
	return nil
}

func (m PaperMetadata) has(key string) bool {
	if key == "creators" {
		return len(m.Creators) > 0
	}
	return *m.textField(key) != ""
}

// Merge fills fields from found unless the user set them. Values read from the
// file only fill empty fields; an online lookup refreshes any automatic value.
func (m *PaperMetadata) Merge(found PaperMetadata, source string) []string {
	changed := []string{}
	for key := range metadataLabels {
		if !found.has(key) || m.Sources[key] == "manual" {
			continue
		}
		if m.has(key) && source != "lookup" {
			continue
		}
		var value any
		if key == "creators" {
			value = found.Creators
		} else {
			raw, _ := json.Marshal(*found.textField(key))
			v, err := normalizeMetadataField(key, raw)
			if err != nil {
				continue
			}
			value = v
		}
		m.set(key, value, source)
		changed = append(changed, key)
	}
	return changed
}

// CreatorNames is the display string kept in documents.author.
func CreatorNames(creators []Creator) string {
	names := []string{}
	for _, c := range creators {
		switch {
		case c.Name != "":
			names = append(names, c.Name)
		case c.Given != "":
			names = append(names, c.Given+" "+c.Family)
		default:
			names = append(names, c.Family)
		}
	}
	return strings.Join(names, ", ")
}
