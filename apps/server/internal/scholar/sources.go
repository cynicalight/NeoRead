package scholar

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"html"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	nethtml "golang.org/x/net/html"
)

// ---------- arXiv ----------

var (
	arxivVersion = regexp.MustCompile(`v\d+$`)
	pageDate     = regexp.MustCompile(`^(\d{4})(?:[/-](\d{1,2})(?:[/-](\d{1,2}))?)?`)
	arxivOldPath = regexp.MustCompile(`/(` + arxivOld + `)`)
	openReviewID = regexp.MustCompile(`^[\w-]+$`)
)

func bareArXiv(id string) string { return arxivVersion.ReplaceAllString(id, "") }

func (c *Client) arxivMetadata(ctx context.Context, id string) (Metadata, error) {
	data, _, _, err := c.get(ctx, c.ArXivAPI+"?id_list="+url.QueryEscape(id), "application/atom+xml", 2<<20)
	if err != nil {
		return Metadata{}, err
	}
	var feed struct {
		Entries []struct {
			ID        string `xml:"id"`
			Title     string `xml:"title"`
			Summary   string `xml:"summary"`
			Published string `xml:"published"`
			DOI       string `xml:"http://arxiv.org/schemas/atom doi"`
			Authors   []struct {
				Name string `xml:"name"`
			} `xml:"author"`
		} `xml:"entry"`
	}
	if xml.Unmarshal(data, &feed) != nil {
		return Metadata{}, Error{"arXiv 返回了无法识别的数据"}
	}
	if len(feed.Entries) == 0 || strings.Contains(feed.Entries[0].ID, "api/errors") || clean(feed.Entries[0].Title) == "" {
		return Metadata{}, ErrNotFound
	}
	e := feed.Entries[0]
	m := Metadata{Title: clean(e.Title), ItemType: "preprint", Abstract: clean(e.Summary), ArXiv: id, DOI: clean(e.DOI), URL: "https://arxiv.org/abs/" + bareArXiv(id)}
	if len(e.Published) >= 10 {
		m.Date = e.Published[:10]
	}
	for _, a := range e.Authors {
		if c := splitName(a.Name); c != (Creator{}) {
			m.Creators = append(m.Creators, c)
		}
	}
	return m, nil
}

func (c *Client) arxivPDF(ctx context.Context, id string) ([]byte, error) {
	data, err := c.pdf(ctx, c.ArXivPDF+id)
	if err != nil && bareArXiv(id) != id {
		// A version in a link may not exist (yet); fall back to the latest.
		return c.pdf(ctx, c.ArXivPDF+bareArXiv(id))
	}
	return data, err
}

// arxivFull adds published-version details from Crossref when arXiv lists a DOI.
func (c *Client) arxivFull(ctx context.Context, id string) (Metadata, error) {
	m, err := c.arxivMetadata(ctx, id)
	if err != nil {
		return m, err
	}
	if m.DOI != "" {
		if pub, e := c.crossref(ctx, m.DOI); e == nil {
			abstract := m.Abstract
			m = overlay(m, pub)
			m.Abstract, m.ArXiv = abstract, id
		}
	}
	return m, nil
}

func (c *Client) arxivResult(ctx context.Context, id string) (Result, error) {
	m, err := c.arxivFull(ctx, id)
	if err != nil && !errors.Is(err, ErrNotFound) {
		// Metadata is optional; the PDF decides whether the import works.
		m = Metadata{ArXiv: id, ItemType: "preprint"}
	}
	data, err := c.arxivPDF(ctx, id)
	if err != nil {
		return Result{}, err
	}
	return Result{PDF: data, Filename: strings.ReplaceAll(id, "/", "_") + ".pdf", Metadata: m}, nil
}

// ---------- Crossref ----------

var crossrefTypes = map[string]string{
	"journal-article": "journal", "proceedings-article": "conference", "posted-content": "preprint",
	"book": "book", "monograph": "book", "edited-book": "book", "book-chapter": "chapter", "book-section": "chapter",
	"dissertation": "thesis", "report": "report",
}
var jatsTag = regexp.MustCompile(`<[^>]+>`)

func datePart(parts [][]int) string {
	if len(parts) == 0 || len(parts[0]) == 0 || parts[0][0] < 1000 {
		return ""
	}
	p := parts[0]
	out := fmt.Sprintf("%04d", p[0])
	if len(p) > 1 && p[1] >= 1 && p[1] <= 12 {
		out += fmt.Sprintf("-%02d", p[1])
		if len(p) > 2 && p[2] >= 1 && p[2] <= 31 {
			out += fmt.Sprintf("-%02d", p[2])
		}
	}
	return out
}

func (c *Client) crossref(ctx context.Context, doi string) (Metadata, error) {
	endpoint := c.Crossref + url.PathEscape(doi)
	if c.CrossrefEmail != "" {
		endpoint += "?" + url.Values{"mailto": {c.CrossrefEmail}}.Encode()
	}
	data, _, _, err := c.get(ctx, endpoint, "application/json", 5<<20)
	var limited rateLimitError
	if errors.As(err, &limited) {
		if c.CrossrefEmail == "" {
			return Metadata{}, Error{"Crossref 服务商限制了请求频率。可前往「设置 → 论文库 → 论文信息服务」填写自己的邮箱，以使用服务商提供的更高额度；也可稍后重试"}
		}
		return Metadata{}, Error{"Crossref 服务商限制了请求频率；请求已携带你填写的邮箱，请稍后重试"}
	}
	if err != nil {
		return Metadata{}, err
	}
	type date struct {
		Parts [][]int `json:"date-parts"`
	}
	var body struct {
		Message struct {
			Type           string   `json:"type"`
			Title          []string `json:"title"`
			ContainerTitle []string `json:"container-title"`
			Publisher      string   `json:"publisher"`
			Volume         string   `json:"volume"`
			Issue          string   `json:"issue"`
			Page           string   `json:"page"`
			ISBN           []string `json:"ISBN"`
			Abstract       string   `json:"abstract"`
			Author         []struct {
				Given  string `json:"given"`
				Family string `json:"family"`
				Name   string `json:"name"`
			} `json:"author"`
			Issued          date `json:"issued"`
			PublishedPrint  date `json:"published-print"`
			PublishedOnline date `json:"published-online"`
		} `json:"message"`
	}
	if json.Unmarshal(data, &body) != nil {
		return Metadata{}, Error{"Crossref 返回了无法识别的数据"}
	}
	r := body.Message
	if len(r.Title) == 0 {
		return Metadata{}, ErrNotFound
	}
	m := Metadata{Title: clean(r.Title[0]), DOI: doi, ItemType: crossrefTypes[r.Type], Publisher: clean(r.Publisher), Volume: clean(r.Volume), Issue: clean(r.Issue), Pages: strings.ReplaceAll(clean(r.Page), "--", "-")}
	if m.ItemType == "" {
		m.ItemType = "other"
	}
	if len(r.ContainerTitle) > 0 {
		m.Venue = clean(r.ContainerTitle[0])
	}
	if len(r.ISBN) > 0 {
		m.ISBN = r.ISBN[0]
	}
	for _, d := range []date{r.Issued, r.PublishedPrint, r.PublishedOnline} {
		if m.Date = datePart(d.Parts); m.Date != "" {
			break
		}
	}
	if r.Abstract != "" {
		text := strings.NewReplacer("</jats:p>", "\n", "</jats:title>", "\n").Replace(r.Abstract)
		paragraphs := []string{}
		for _, p := range strings.Split(html.UnescapeString(jatsTag.ReplaceAllString(text, " ")), "\n") {
			if p = clean(p); p != "" && !strings.EqualFold(p, "abstract") {
				paragraphs = append(paragraphs, p)
			}
		}
		m.Abstract = strings.Join(paragraphs, "\n")
	}
	for _, a := range r.Author {
		switch {
		case a.Family != "":
			m.Creators = append(m.Creators, Creator{Given: clean(a.Given), Family: clean(a.Family)})
		case a.Name != "":
			m.Creators = append(m.Creators, Creator{Name: clean(a.Name)})
		}
	}
	return m, nil
}

// ---------- Semantic Scholar ----------

type s2Paper struct {
	Title           string `json:"title"`
	Abstract        string `json:"abstract"`
	Venue           string `json:"venue"`
	Year            int    `json:"year"`
	PublicationDate string `json:"publicationDate"`
	URL             string `json:"url"`
	ExternalIDs     struct {
		DOI   string `json:"DOI"`
		ArXiv string `json:"ArXiv"`
	} `json:"externalIds"`
	OpenAccessPDF *struct {
		URL string `json:"url"`
	} `json:"openAccessPdf"`
	Authors []struct {
		Name string `json:"name"`
	} `json:"authors"`
	PublicationTypes []string `json:"publicationTypes"`
}

const s2Fields = "title,authors,year,venue,publicationDate,externalIds,openAccessPdf,abstract,url,publicationTypes"

func (c *Client) s2(ctx context.Context, key string) (s2Paper, error) {
	var p s2Paper
	data, _, _, err := c.get(ctx, c.SemanticScholar+key+"?fields="+s2Fields, "application/json", 5<<20)
	if err == nil && json.Unmarshal(data, &p) != nil {
		err = Error{"Semantic Scholar 返回了无法识别的数据"}
	}
	if err == nil && p.Title == "" {
		err = ErrNotFound
	}
	return p, err
}

func (c *Client) s2Search(ctx context.Context, title string) (s2Paper, error) {
	data, _, _, err := c.get(ctx, c.SemanticScholar+"search/match?query="+url.QueryEscape(title)+"&fields="+s2Fields, "application/json", 5<<20)
	if err != nil {
		return s2Paper{}, err
	}
	var body struct {
		Data []s2Paper `json:"data"`
	}
	if json.Unmarshal(data, &body) != nil || len(body.Data) == 0 || body.Data[0].Title == "" {
		return s2Paper{}, ErrNotFound
	}
	return body.Data[0], nil
}

func (p s2Paper) metadata() Metadata {
	m := Metadata{Title: clean(p.Title), Abstract: clean(p.Abstract), Venue: clean(p.Venue), DOI: p.ExternalIDs.DOI, ArXiv: p.ExternalIDs.ArXiv, Date: p.PublicationDate}
	if m.Date == "" && p.Year > 0 {
		m.Date = fmt.Sprint(p.Year)
	}
	for _, a := range p.Authors {
		if c := splitName(a.Name); c != (Creator{}) {
			m.Creators = append(m.Creators, c)
		}
	}
	for _, t := range p.PublicationTypes {
		switch t {
		case "JournalArticle":
			m.ItemType = "journal"
		case "Conference":
			m.ItemType = "conference"
		}
	}
	if m.ItemType == "" && m.ArXiv != "" && m.Venue == "" {
		m.ItemType = "preprint"
	}
	return m
}

// ---------- OpenReview ----------

func (c *Client) openReviewResult(ctx context.Context, id string) (Result, error) {
	data, err := c.pdf(ctx, c.OpenReview+"pdf?id="+url.QueryEscape(id))
	if err != nil {
		return Result{}, err
	}
	m := Metadata{URL: "https://openreview.net/forum?id=" + id, ItemType: "conference"}
	if body, _, _, e := c.get(ctx, c.OpenReviewAPI+"?id="+url.QueryEscape(id), "application/json", 2<<20); e == nil {
		type value struct {
			Value any `json:"value"`
		}
		var notes struct {
			Notes []struct {
				PDate   int64            `json:"pdate"`
				CDate   int64            `json:"cdate"`
				Content map[string]value `json:"content"`
			} `json:"notes"`
		}
		if json.Unmarshal(body, &notes) == nil && len(notes.Notes) > 0 {
			n := notes.Notes[0]
			text := func(key string) string {
				s, _ := n.Content[key].Value.(string)
				return clean(s)
			}
			m.Title, m.Abstract, m.Venue = text("title"), text("abstract"), text("venue")
			if authors, ok := n.Content["authors"].Value.([]any); ok {
				for _, a := range authors {
					if name, ok := a.(string); ok {
						m.Creators = append(m.Creators, splitName(name))
					}
				}
			}
			if stamp := max(n.PDate, n.CDate); stamp > 0 {
				m.Date = time.UnixMilli(stamp).UTC().Format("2006-01-02")
			}
		}
	}
	return Result{PDF: data, Filename: "openreview-" + id + ".pdf", Metadata: m}, nil
}

// ---------- publisher pages ----------

// pageMeta collects <meta name|property=… content=…> values, lowercased by name.
func pageMeta(page []byte) (map[string][]string, []string) {
	tags := map[string][]string{}
	links := []string{}
	z := nethtml.NewTokenizer(bytes.NewReader(page))
	for {
		switch z.Next() {
		case nethtml.ErrorToken:
			return tags, links
		case nethtml.StartTagToken, nethtml.SelfClosingTagToken:
			name, hasAttr := z.TagName()
			if !hasAttr || (string(name) != "meta" && string(name) != "a") {
				continue
			}
			attrs := map[string]string{}
			for {
				k, v, more := z.TagAttr()
				attrs[strings.ToLower(string(k))] = string(v)
				if !more {
					break
				}
			}
			if string(name) == "a" {
				if href := attrs["href"]; strings.HasSuffix(strings.ToLower(strings.SplitN(href, "?", 2)[0]), ".pdf") {
					links = append(links, href)
				}
				continue
			}
			key := strings.ToLower(attrs["name"])
			if key == "" {
				key = strings.ToLower(attrs["property"])
			}
			if key != "" && attrs["content"] != "" {
				tags[key] = append(tags[key], strings.TrimSpace(attrs["content"]))
			}
		}
	}
}

func pageMetadata(tags map[string][]string, page string) Metadata {
	first := func(keys ...string) string {
		for _, k := range keys {
			if v := tags[k]; len(v) > 0 && clean(v[0]) != "" {
				return clean(v[0])
			}
		}
		return ""
	}
	m := Metadata{
		Title:     first("citation_title", "dc.title", "og:title"),
		Date:      first("citation_publication_date", "citation_date", "citation_online_date", "dc.date"),
		Venue:     first("citation_journal_title", "citation_conference_title", "citation_inbook_title"),
		Volume:    first("citation_volume"),
		Issue:     first("citation_issue"),
		Publisher: first("citation_publisher", "dc.publisher"),
		DOI:       strings.TrimPrefix(first("citation_doi", "dc.identifier"), "doi:"),
		ArXiv:     first("citation_arxiv_id"),
		Abstract:  first("citation_abstract"),
		URL:       page,
	}
	if first, last := first("citation_firstpage"), first("citation_lastpage"); first != "" {
		m.Pages = first
		if last != "" && last != first {
			m.Pages += "-" + last
		}
	}
	// "2023/05/17" and "2023-5-7" both become ISO dates.
	if d := pageDate.FindStringSubmatch(m.Date); d != nil {
		m.Date = d[1]
		if month, _ := strconv.Atoi(d[2]); month >= 1 && month <= 12 {
			m.Date += fmt.Sprintf("-%02d", month)
			if day, _ := strconv.Atoi(d[3]); day >= 1 && day <= 31 {
				m.Date += fmt.Sprintf("-%02d", day)
			}
		}
	} else {
		m.Date = ""
	}
	if !doiText.MatchString(m.DOI) {
		m.DOI = ""
	}
	for _, a := range tags["citation_author"] {
		if len(m.Creators) == 200 {
			break
		}
		if c := splitName(a); c != (Creator{}) {
			m.Creators = append(m.Creators, c)
		}
	}
	if m.Venue != "" && tags["citation_journal_title"] != nil {
		m.ItemType = "journal"
	} else if tags["citation_conference_title"] != nil {
		m.ItemType = "conference"
	}
	return m
}

func (c *Client) pageResult(ctx context.Context, raw string) (Result, error) {
	data, ctype, final, err := c.get(ctx, raw, "text/html,application/pdf;q=0.9,*/*;q=0.8", max(c.MaxPDF, 3<<20))
	if err != nil {
		return Result{}, err
	}
	if bytes.HasPrefix(data, []byte("%PDF-")) {
		if int64(len(data)) > c.MaxPDF {
			return Result{}, Error{fmt.Sprintf("文件超过 %d MB", c.MaxPDF>>20)}
		}
		return Result{PDF: data, Filename: filename(final, "paper.pdf"), Metadata: Metadata{URL: raw}}, nil
	}
	if strings.Contains(ctype, "pdf") || len(data) > 3<<20 {
		return Result{}, Error{"链接打开的不是 PDF 或论文页面"}
	}
	tags, links := pageMeta(data)
	m := pageMetadata(tags, raw)
	pdfURL := ""
	if v := tags["citation_pdf_url"]; len(v) > 0 {
		pdfURL = v[0]
	} else if len(links) > 0 {
		pdfURL = links[0]
	}
	if pdfURL != "" {
		if base, e := url.Parse(final); e == nil {
			if ref, e := base.Parse(html.UnescapeString(pdfURL)); e == nil {
				if pdf, e := c.pdf(ctx, ref.String()); e == nil {
					return Result{PDF: pdf, Filename: filename(ref.String(), "paper.pdf"), Metadata: m}, nil
				}
			}
		}
	}
	if m.ArXiv != "" {
		r, e := c.arxivResult(ctx, m.ArXiv)
		if e == nil {
			r.Metadata = overlay(r.Metadata, m)
		}
		return r, e
	}
	if m.DOI != "" && !strings.Contains(raw, m.DOI) {
		return c.doiResult(ctx, m.DOI)
	}
	if m.Title != "" {
		return Result{}, Error{fmt.Sprintf("找到了《%s》，但页面里没有可以下载的 PDF。可能需要登录或订阅，请下载后拖进来", m.Title)}
	}
	return Result{}, Error{"这个网页里没有找到可以下载的 PDF。可能需要登录或订阅，请下载后拖进来"}
}

// ---------- DOI and title ----------

func (c *Client) doiMetadata(ctx context.Context, doi string) (Metadata, s2Paper, error) {
	m, err := c.crossref(ctx, doi)
	p, s2err := c.s2(ctx, "DOI:"+doi)
	if err != nil {
		if s2err != nil {
			return Metadata{}, p, err
		}
		m = p.metadata()
	}
	if m.ArXiv == "" {
		m.ArXiv = p.ExternalIDs.ArXiv
	}
	if m.Abstract == "" {
		m.Abstract = clean(p.Abstract)
	}
	m.DOI = doi
	return m, p, nil
}

func (c *Client) doiResult(ctx context.Context, doi string) (Result, error) {
	m, p, err := c.doiMetadata(ctx, doi)
	if err != nil && !errors.Is(err, ErrNotFound) {
		return Result{}, err
	}
	name := filename(strings.ReplaceAll(doi, "/", "_"), "paper.pdf")
	if m.ArXiv != "" {
		if data, e := c.arxivPDF(ctx, m.ArXiv); e == nil {
			return Result{PDF: data, Filename: name, Metadata: m}, nil
		}
	}
	if p.OpenAccessPDF != nil && p.OpenAccessPDF.URL != "" {
		if data, e := c.pdf(ctx, p.OpenAccessPDF.URL); e == nil {
			return Result{PDF: data, Filename: name, Metadata: m}, nil
		}
	}
	page, e := c.pageResult(ctx, c.DOIResolver+doi)
	if e == nil {
		page.Metadata = overlay(page.Metadata, m)
		return page, nil
	}
	if m.Title != "" {
		return Result{}, Error{fmt.Sprintf("找到了《%s》，但没有公开的 PDF。请从出版社或图书馆下载后拖进来", m.Title)}
	}
	return Result{}, e
}

func (c *Client) titleMatch(ctx context.Context, title string, threshold float64) (s2Paper, error) {
	p, err := c.s2Search(ctx, title)
	if err != nil {
		return p, err
	}
	if TitleSimilarity(title, p.Title) < threshold {
		return p, ErrNotFound
	}
	return p, nil
}

// ---------- entry points ----------

// Resolve downloads a paper from an arXiv ID, DOI, paper link, PDF link or title.
func (c *Client) Resolve(ctx context.Context, ref string) (Result, error) {
	ref = strings.Trim(strings.TrimSpace(ref), "<>")
	if ref == "" {
		return Result{}, Error{"请填写链接、arXiv 编号、DOI 或论文标题"}
	}
	low := strings.ToLower(ref)
	isURL := strings.HasPrefix(low, "http://") || strings.HasPrefix(low, "https://")
	if !isURL {
		if m := arxivID.FindStringSubmatch(ref); m != nil {
			return c.arxivResult(ctx, m[1])
		}
		if m := doiText.FindStringSubmatch(ref); m != nil && strings.HasPrefix(strings.TrimSpace(strings.TrimPrefix(low, "doi:")), "10.") {
			return c.doiResult(ctx, m[1])
		}
		if len([]rune(ref)) < 8 {
			return Result{}, Error{"无法识别。可以填写 arXiv 编号、DOI、论文链接、PDF 链接或完整标题"}
		}
		p, err := c.titleMatch(ctx, ref, 0.5)
		if err != nil {
			return Result{}, err
		}
		switch {
		case p.ExternalIDs.DOI != "":
			return c.doiResult(ctx, p.ExternalIDs.DOI)
		case p.ExternalIDs.ArXiv != "":
			return c.arxivResult(ctx, p.ExternalIDs.ArXiv)
		case p.OpenAccessPDF != nil && p.OpenAccessPDF.URL != "":
			data, e := c.pdf(ctx, p.OpenAccessPDF.URL)
			if e != nil {
				return Result{}, e
			}
			return Result{PDF: data, Filename: filename(p.OpenAccessPDF.URL, "paper.pdf"), Metadata: p.metadata()}, nil
		}
		return Result{}, Error{fmt.Sprintf("找到了《%s》，但没有公开的 PDF。请下载后拖进来", p.Title)}
	}
	u, err := url.Parse(ref)
	if err != nil {
		return Result{}, Error{"链接无效"}
	}
	host := strings.TrimPrefix(strings.ToLower(u.Host), "www.")
	if host == "doi.org" || host == "dx.doi.org" {
		if m := doiText.FindStringSubmatch(u.Path); m != nil {
			doi, _ := url.PathUnescape(m[1])
			return c.doiResult(ctx, doi)
		}
	}
	for _, mirror := range arxivMirrors {
		if strings.Contains(host+u.Path, mirror) {
			if m := arxivPath.FindStringSubmatch(u.Path); m != nil {
				return c.arxivResult(ctx, m[1])
			}
			if m := arxivOldPath.FindStringSubmatch(u.Path); m != nil && host == "arxiv.org" {
				return c.arxivResult(ctx, strings.TrimSuffix(m[1], ".pdf"))
			}
		}
	}
	if host == "openreview.net" {
		if id := u.Query().Get("id"); id != "" && openReviewID.MatchString(id) {
			return c.openReviewResult(ctx, id)
		}
	}
	if host == "aclanthology.org" && strings.HasSuffix(u.Path, ".pdf") {
		// The landing page carries the metadata and links back to the PDF.
		landing := *u
		landing.Path = strings.TrimSuffix(u.Path, ".pdf") + "/"
		ref = landing.String()
	}
	result, err := c.pageResult(ctx, ref)
	if err != nil {
		// Paper sites without a PDF link often carry an arXiv ID in the path.
		if m := arxivPath.FindStringSubmatch(u.Path); m != nil {
			return c.arxivResult(ctx, m[1])
		}
	}
	return result, err
}

// Lookup finds metadata without downloading a PDF. A title match must be close.
func (c *Client) Lookup(ctx context.Context, ids Identifiers) (Metadata, error) {
	switch {
	case ids.ArXiv != "":
		return c.arxivFull(ctx, ids.ArXiv)
	case ids.DOI != "":
		m, _, err := c.doiMetadata(ctx, ids.DOI)
		return m, err
	case ids.Title != "":
		p, err := c.titleMatch(ctx, ids.Title, 0.8)
		if err != nil {
			return Metadata{}, err
		}
		if p.ExternalIDs.DOI != "" {
			if m, _, e := c.doiMetadata(ctx, p.ExternalIDs.DOI); e == nil {
				return m, nil
			}
		}
		return p.metadata(), nil
	}
	return Metadata{}, ErrNotFound
}
