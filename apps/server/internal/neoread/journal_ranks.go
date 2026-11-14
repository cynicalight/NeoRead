package neoread

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

var journalRankURL = "https://www.easyscholar.cc/open/getPublicationRank"

var defaultJournalRankFields = []string{"sciif", "sci", "sciUp", "sciUpSmall"}
var journalRankFieldOrder = []string{"sciif", "sciif5", "jci", "sci", "ssci", "sciUp", "sciUpSmall", "sciBase", "sciBaseSmall", "sciUpTop"}

var journalRankNames = map[string]string{
	"sciif": "IF", "sciif5": "五年 IF", "jci": "JCI", "sci": "SCI/JCR",
	"ssci": "SSCI/JCR", "sciUp": "中科院", "sciUpSmall": "中科院小类",
	"sciBase": "中科院基础版", "sciBaseSmall": "中科院基础版小类",
	"ccf": "CCF", "cscd": "CSCD", "pku": "北大核心", "cssci": "CSSCI",
	"ahci": "A&HCI", "ajg": "AJG", "fms": "FMS", "ft50": "FT50",
	"utd24": "UTD24", "scopus": "Scopus", "eii": "EI", "sciwarn": "中科院预警",
	"sciUpTop": "中科院 TOP", "esi": "ESI 学科",
	"swufe": "西南财经大学", "cufe": "中央财经大学", "uibe": "对外经济贸易大学",
	"sdufe": "山东财经大学", "swjtu": "西南交通大学", "hhu": "河海大学",
	"nju": "南京大学", "xju": "新疆大学", "cug": "中国地质大学",
	"ruc": "中国人民大学", "scu": "四川大学",
}

type journalRankField struct {
	Key  string `json:"key"`
	Name string `json:"name"`
}
type journalRankConfig struct {
	Enabled    bool               `json:"enabled"`
	HasKey     bool               `json:"hasKey"`
	FilterMode string             `json:"filterMode"`
	Selected   []string           `json:"selected"`
	Available  []journalRankField `json:"available"`
}
type journalRankBadge struct {
	Key     string `json:"key"`
	Name    string `json:"name"`
	Value   string `json:"value"`
	Subject string `json:"subject,omitempty"`
	Year    string `json:"year,omitempty"`
}
type journalRankResult struct {
	Status    string             `json:"status"`
	Badges    []journalRankBadge `json:"badges"`
	CheckedAt string             `json:"checkedAt,omitempty"`
}

func journalName(name string) string { return strings.ToLower(strings.Join(strings.Fields(name), " ")) }
func journalKeyHash(key string) string {
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:])
}

func (s *Server) journalConfig() (journalRankConfig, string, error) {
	c := journalRankConfig{Enabled: true, FilterMode: "include", Selected: append([]string(nil), defaultJournalRankFields...), Available: []journalRankField{}}
	var raw, key string
	if err := s.Store.DB.QueryRow("SELECT value FROM settings WHERE key='journal-rank:config'").Scan(&raw); err == nil {
		var saved struct {
			Enabled    *bool    `json:"enabled"`
			FilterMode string   `json:"filterMode"`
			Selected   []string `json:"selected"`
		}
		if json.Unmarshal([]byte(raw), &saved) == nil {
			if saved.Enabled != nil {
				c.Enabled = *saved.Enabled
			}
			if saved.Selected != nil {
				c.Selected = saved.Selected
			}
			if saved.FilterMode == "include" || saved.FilterMode == "exclude" {
				c.FilterMode = saved.FilterMode
			}
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		return c, "", err
	}
	if err := s.Store.DB.QueryRow("SELECT value FROM settings WHERE key='journal-rank:key'").Scan(&key); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return c, "", err
	}
	c.HasKey = key != ""
	return c, key, nil
}

func (s *Server) getJournalRankConfig(w http.ResponseWriter, r *http.Request) {
	c, _, err := s.journalConfig()
	if err != nil {
		fail(w, 500, "无法读取期刊指标设置")
		return
	}
	fields := map[string]string{}
	for key, name := range journalRankNames {
		fields[key] = name
	}
	rows, err := s.Store.DB.Query("SELECT body FROM journal_rank_cache")
	if err == nil {
		for rows.Next() {
			var raw string
			if rows.Scan(&raw) != nil {
				continue
			}
			var result journalRankResult
			if json.Unmarshal([]byte(raw), &result) != nil {
				continue
			}
			for _, badge := range result.Badges {
				fields[badge.Key] = badge.Name
			}
		}
		rows.Close()
	}
	for key, name := range fields {
		c.Available = append(c.Available, journalRankField{key, name})
	}
	order := map[string]int{}
	for i, key := range journalRankFieldOrder {
		order[key] = i + 1
	}
	sort.Slice(c.Available, func(i, j int) bool {
		a, b := order[c.Available[i].Key], order[c.Available[j].Key]
		if a != b {
			if a == 0 {
				return false
			}
			if b == 0 {
				return true
			}
			return a < b
		}
		return c.Available[i].Key < c.Available[j].Key
	})
	respond(w, 200, c)
}

func (s *Server) putJournalRankConfig(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Enabled    *bool    `json:"enabled"`
		FilterMode string   `json:"filterMode"`
		Selected   []string `json:"selected"`
		Key        *string  `json:"key"`
	}
	if !decode(w, r, &input) {
		return
	}
	if input.Enabled == nil || input.Selected == nil || len(input.Selected) > 128 {
		fail(w, 400, "期刊指标设置无效")
		return
	}
	if input.FilterMode == "" {
		current, _, err := s.journalConfig()
		if err != nil {
			fail(w, 500, "无法读取期刊指标设置")
			return
		}
		input.FilterMode = current.FilterMode
	}
	if input.FilterMode != "include" && input.FilterMode != "exclude" {
		fail(w, 400, "期刊指标筛选方式无效")
		return
	}
	seen := map[string]bool{}
	for _, field := range input.Selected {
		if field == "" || len(field) > 100 || seen[field] {
			fail(w, 400, "期刊指标选择无效")
			return
		}
		seen[field] = true
	}
	if input.Key != nil && len(*input.Key) > 500 {
		fail(w, 400, "SecretKey 过长")
		return
	}
	tx, err := s.Store.DB.Begin()
	if err != nil {
		fail(w, 500, "无法保存期刊指标设置")
		return
	}
	defer tx.Rollback()
	config, _ := json.Marshal(map[string]any{"enabled": *input.Enabled, "filterMode": input.FilterMode, "selected": input.Selected})
	_, err = tx.Exec("INSERT INTO settings(key,value) VALUES('journal-rank:config',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", string(config))
	if err == nil && input.Key != nil {
		_, err = tx.Exec("INSERT INTO settings(key,value) VALUES('journal-rank:key',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", strings.TrimSpace(*input.Key))
	}
	if err != nil || tx.Commit() != nil {
		fail(w, 500, "无法保存期刊指标设置")
		return
	}
	s.getJournalRankConfig(w, r)
}

func rankScalar(v any) string {
	switch value := v.(type) {
	case string:
		return strings.TrimSpace(value)
	case float64:
		return fmt.Sprint(value)
	case bool:
		if value {
			return "收录"
		}
	}
	return ""
}

// Keep every subject in the provider response. Unknown fields remain selectable
// under their returned key instead of being silently discarded.
func parseJournalRank(raw []byte) (journalRankResult, error) {
	result := journalRankResult{Status: "notFound", Badges: []journalRankBadge{}}
	var response struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
		Data struct {
			OfficialRank struct {
				All map[string]any `json:"all"`
			} `json:"officialRank"`
			CustomRank map[string]any `json:"customRank"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &response); err != nil {
		return result, errors.New("期刊指标响应无效")
	}
	if response.Code != 200 {
		if response.Code == 401 || response.Code == 403 || strings.Contains(strings.ToLower(response.Msg), "key") {
			return result, errors.New("easyScholar SecretKey 无效或已失效")
		}
		return result, errors.New("easyScholar 查询失败，请稍后重试")
	}
	add := func(key, subject, value, year string) {
		if value == "" {
			return
		}
		name := journalRankNames[key]
		if name == "" {
			name = key
		}
		// The API packs several small-category ranks into one string.
		if key == "sciUpSmall" || key == "sciBaseSmall" || key == "xrSmall" {
			for _, part := range strings.FieldsFunc(value, func(r rune) bool { return r == '/' || r == ';' || r == '；' || r == '。' }) {
				if part = strings.TrimSpace(part); part != "" {
					result.Badges = append(result.Badges, journalRankBadge{Key: key, Name: name, Subject: subject, Value: part, Year: year})
				}
			}
			return
		}
		result.Badges = append(result.Badges, journalRankBadge{Key: key, Name: name, Subject: subject, Value: value, Year: year})
	}
	var walk func(string, string, any)
	walk = func(key, subject string, value any) {
		if scalar := rankScalar(value); scalar != "" {
			add(key, subject, scalar, "")
			return
		}
		switch v := value.(type) {
		case []any:
			for _, item := range v {
				walk(key, subject, item)
			}
		case map[string]any:
			year := rankScalar(v["year"])
			if year == "" {
				year = rankScalar(v["version"])
			}
			subjectName := rankScalar(v["subject"])
			if subjectName == "" {
				subjectName = rankScalar(v["category"])
			}
			if subjectName == "" {
				subjectName = subject
			}
			grade := rankScalar(v["rank"])
			if grade == "" {
				grade = rankScalar(v["value"])
			}
			if grade == "" {
				grade = rankScalar(v["grade"])
			}
			if grade != "" {
				add(key, subjectName, grade, year)
				return
			}
			keys := make([]string, 0, len(v))
			for name := range v {
				if name != "year" && name != "version" {
					keys = append(keys, name)
				}
			}
			sort.Strings(keys)
			for _, name := range keys {
				walk(key, name, v[name])
			}
		}
	}
	keys := make([]string, 0, len(response.Data.OfficialRank.All))
	for key := range response.Data.OfficialRank.All {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		walk(key, "", response.Data.OfficialRank.All[key])
	}
	// Custom ranks refer to rankInfo entries by UUID and a numeric level.
	// Keep the UUID in the choice key because abbreviated names can repeat.
	infoByID := map[string]map[string]any{}
	if infos, ok := response.Data.CustomRank["rankInfo"].([]any); ok {
		for _, item := range infos {
			if info, ok := item.(map[string]any); ok {
				if uuid := rankScalar(info["uuid"]); uuid != "" {
					infoByID[uuid] = info
				}
			}
		}
	}
	if ranks, ok := response.Data.CustomRank["rank"].([]any); ok {
		levels := []string{"", "oneRankText", "twoRankText", "threeRankText", "fourRankText", "fiveRankText", "sixRankText", "sevenRankText"}
		for _, item := range ranks {
			parts := strings.SplitN(rankScalar(item), "&&&", 2)
			if len(parts) != 2 {
				continue
			}
			info := infoByID[parts[0]]
			if info == nil {
				continue
			}
			level := strings.TrimSpace(parts[1])
			if len(level) != 1 || level[0] < '1' || int(level[0]-'0') >= len(levels) {
				continue
			}
			name := rankScalar(info["abbName"])
			if name == "" {
				name = parts[0]
			}
			grade := rankScalar(info[levels[level[0]-'0']])
			if grade == "" {
				grade = "收录"
			}
			result.Badges = append(result.Badges, journalRankBadge{Key: "custom:" + parts[0], Name: name, Value: grade})
		}
	}
	// Preserve any additional named datasets the service returns.
	for key, value := range response.Data.CustomRank {
		if key != "rank" && key != "rankInfo" {
			walk("custom:"+key, "", value)
		}
	}
	if len(result.Badges) > 0 {
		result.Status = "found"
	}
	return result, nil
}

func (s *Server) cachedJournalRank(name, hash string, refresh bool) (journalRankResult, bool) {
	var raw, checked string
	err := s.Store.DB.QueryRow("SELECT body,checked_at FROM journal_rank_cache WHERE name=? AND key_hash=?", name, hash).Scan(&raw, &checked)
	if err != nil {
		return journalRankResult{}, false
	}
	var result journalRankResult
	if json.Unmarshal([]byte(raw), &result) != nil {
		return journalRankResult{}, false
	}
	when, err := time.Parse(time.RFC3339Nano, checked)
	if err != nil || (!refresh && time.Since(when) > 30*24*time.Hour) {
		return journalRankResult{}, false
	}
	if refresh {
		return journalRankResult{}, false
	}
	return result, true
}

func (s *Server) fetchJournalRank(ctx context.Context, name, key string, upstreamTimeout time.Duration) (journalRankResult, error) {
	s.journalRankMu.Lock()
	defer s.journalRankMu.Unlock()
	if wait := time.Until(s.journalRankLast.Add(550 * time.Millisecond)); wait > 0 {
		select {
		case <-ctx.Done():
			return journalRankResult{}, ctx.Err()
		case <-time.After(wait):
		}
	}
	s.journalRankLast = time.Now()
	requestCtx, cancel := context.WithTimeout(ctx, upstreamTimeout)
	defer cancel()
	u, _ := url.Parse(journalRankURL)
	params := u.Query()
	params.Set("secretKey", key)
	params.Set("publicationName", name)
	u.RawQuery = params.Encode()
	req, err := http.NewRequestWithContext(requestCtx, http.MethodGet, u.String(), nil)
	if err != nil {
		return journalRankResult{}, errors.New("无法创建期刊查询")
	}
	client := &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(req)
	if err != nil {
		return journalRankResult{}, errors.New("easyScholar 网络请求失败")
	}
	defer response.Body.Close()
	if response.StatusCode == 401 || response.StatusCode == 403 {
		return journalRankResult{}, errors.New("easyScholar SecretKey 无效或已失效")
	}
	if response.StatusCode == 429 {
		return journalRankResult{}, errors.New("easyScholar 请求过于频繁，请稍后重试")
	}
	if response.StatusCode != 200 {
		return journalRankResult{}, errors.New("easyScholar 服务暂时不可用")
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return journalRankResult{}, errors.New("无法读取期刊查询结果")
	}
	result, err := parseJournalRank(body)
	if err != nil {
		return result, err
	}
	result.CheckedAt = now()
	return result, nil
}

func (s *Server) documentJournalRank(w http.ResponseWriter, r *http.Request) {
	started := time.Now()
	queryStatus := "error"
	knownConference, cacheHit, shared := false, false, false
	defer func() {
		level := slog.LevelInfo
		if queryStatus == "error" {
			level = slog.LevelError
		}
		s.diagnosticEvent(level, "journal_rank.query", "requestId", requestID(r.Context()),
			"queryStatus", queryStatus, "knownConference", knownConference,
			"cacheHit", cacheHit, "shared", shared, "durationMs", time.Since(started).Milliseconds())
	}()
	config, key, err := s.journalConfig()
	if err != nil {
		fail(w, 500, "无法读取期刊指标设置")
		return
	}
	if !config.Enabled || key == "" {
		queryStatus = "disabled"
		respond(w, 200, journalRankResult{Status: "disabled", Badges: []journalRankBadge{}})
		return
	}
	doc, err := s.Store.Document(r.PathValue("id"))
	if err != nil || doc.Library != "papers" || doc.DeletedAt != "" {
		fail(w, 404, "论文不存在")
		return
	}
	if doc.Metadata.ItemType != "" && doc.Metadata.ItemType != "journal" && doc.Metadata.ItemType != "conference" {
		queryStatus = "notApplicable"
		respond(w, 200, journalRankResult{Status: "notApplicable", Badges: []journalRankBadge{}})
		return
	}
	publicationName := strings.Join(strings.Fields(doc.Metadata.Venue), " ")
	if publicationName == "" {
		queryStatus = "noVenue"
		respond(w, 200, journalRankResult{Status: "noVenue", Badges: []journalRankBadge{}})
		return
	}
	name := journalName(publicationName)
	if conference, ok := matchConference(publicationName); ok {
		knownConference = true
		publicationName = conference.Abbreviation
		// Keep all pre-normalization cache entries, including incomplete found
		// results, outside the corrected conference lookup namespace.
		name = "conference-v1:" + journalName(conference.Abbreviation)
	}
	hash := journalKeyHash(key)
	refresh := r.URL.Query().Get("refresh") == "1"
	if cached, ok := s.cachedJournalRank(name, hash, refresh); ok {
		cacheHit = true
		queryStatus = cached.Status
		respond(w, 200, cached)
		return
	}
	value, err, shared := s.journalRankRequests.Do(hash+":"+name, func() (any, error) {
		if cached, ok := s.cachedJournalRank(name, hash, refresh); ok {
			cacheHit = true
			return cached, nil
		}
		result, err := s.fetchJournalRank(context.Background(), publicationName, key, 20*time.Second)
		if err != nil {
			return result, err
		}
		body, _ := json.Marshal(result)
		if _, err = s.Store.DB.Exec("INSERT INTO journal_rank_cache(name,key_hash,body,checked_at) VALUES(?,?,?,?) ON CONFLICT(name,key_hash) DO UPDATE SET body=excluded.body,checked_at=excluded.checked_at", name, hash, string(body), result.CheckedAt); err != nil {
			return result, errors.New("无法保存期刊指标缓存")
		}
		return result, nil
	})
	if err != nil {
		fail(w, 502, err.Error())
		return
	}
	queryStatus = value.(journalRankResult).Status
	respond(w, 200, value)
}
