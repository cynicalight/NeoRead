// Package scholar finds paper PDFs and bibliographic metadata from arXiv,
// Crossref, Semantic Scholar, OpenReview and publisher pages. Requests go only
// to public http(s) hosts; callers decide when a lookup may leave the machine.
package scholar

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode"
)

type Creator struct {
	Given  string
	Family string
	Name   string
}

// Metadata uses the same field meanings as the reader's paper metadata.
type Metadata struct {
	Title     string
	ItemType  string
	Creators  []Creator
	Date      string
	Venue     string
	Volume    string
	Issue     string
	Pages     string
	Publisher string
	DOI       string
	ArXiv     string
	ISBN      string
	URL       string
	Abstract  string
}

type Identifiers struct {
	DOI   string
	ArXiv string
	Title string
}

type Result struct {
	PDF      []byte
	Filename string
	Metadata Metadata
}

// Error carries a message that can be shown to the user.
type Error struct{ Message string }

func (e Error) Error() string { return e.Message }

var ErrNotFound = Error{"没有找到这篇论文"}

type rateLimitError struct{ cause Error }

func (e rateLimitError) Unwrap() error { return e.cause }

func (e rateLimitError) Error() string { return e.cause.Message }

type Client struct {
	HTTP            *http.Client
	ArXivAPI        string
	ArXivPDF        string
	Crossref        string
	SemanticScholar string
	CrossrefEmail   string
	OpenReview      string
	OpenReviewAPI   string
	DOIResolver     string
	// Tests serve fixtures from loopback addresses.
	AllowPrivateHosts bool
	MaxPDF            int64
}

func New(maxPDF int64) *Client {
	c := &Client{
		ArXivAPI:        "https://export.arxiv.org/api/query",
		ArXivPDF:        "https://arxiv.org/pdf/",
		Crossref:        "https://api.crossref.org/works/",
		SemanticScholar: "https://api.semanticscholar.org/graph/v1/paper/",
		OpenReview:      "https://openreview.net/",
		OpenReviewAPI:   "https://api2.openreview.net/notes",
		DOIResolver:     "https://doi.org/",
		MaxPDF:          maxPDF,
	}
	c.HTTP = &http.Client{
		Timeout:   90 * time.Second,
		Transport: &http.Transport{Proxy: http.ProxyFromEnvironment, TLSHandshakeTimeout: 15 * time.Second, ResponseHeaderTimeout: 30 * time.Second},
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 8 {
				return errors.New("too many redirects")
			}
			return c.checkURL(req.URL)
		},
	}
	return c
}

var (
	arxivNew  = `\d{4}\.\d{4,5}(?:v\d+)?`
	arxivOld  = `[a-z\-]+(?:\.[A-Z]{2})?/\d{7}(?:v\d+)?`
	arxivID   = regexp.MustCompile(`(?i)^(?:arxiv:\s*)?(` + arxivNew + `|` + arxivOld + `)$`)
	arxivText = regexp.MustCompile(`(?i)arxiv:\s*(` + arxivNew + `|` + arxivOld + `)`)
	arxivPath = regexp.MustCompile(`(?:^|[/=])(` + arxivNew + `)(?:$|[/?#.]|\.pdf)`)
	doiText   = regexp.MustCompile(`\b(10\.\d{4,9}/[^\s"<>]+[^\s"<>.,;)\]])`)
)

// arxivMirrors are paper sites whose links carry an arXiv identifier.
var arxivMirrors = []string{"arxiv.org", "alphaxiv.org", "huggingface.co/papers", "hf.co/papers", "papers.cool/arxiv", "paperswithcode.com", "semanticscholar.org/arxiv", "scholar.archive.org", "chatpaper", "papers.labml.ai"}

// Detect finds an arXiv identifier or DOI in the first pages of a paper.
func Detect(text string) Identifiers {
	if len(text) > 8000 {
		text = text[:8000]
	}
	var ids Identifiers
	if m := arxivText.FindStringSubmatch(text); m != nil {
		ids.ArXiv = m[1]
	}
	if m := doiText.FindStringSubmatch(text); m != nil {
		ids.DOI = m[1]
	}
	return ids
}

func (c *Client) checkURL(u *url.URL) error {
	if u.Scheme != "http" && u.Scheme != "https" {
		return Error{"只支持 http 和 https 链接"}
	}
	host := strings.ToLower(u.Hostname())
	if host == "" {
		return Error{"链接缺少主机名"}
	}
	if c.AllowPrivateHosts {
		return nil
	}
	if host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") {
		return Error{"不能访问本机或局域网地址"}
	}
	if ip := net.ParseIP(host); ip != nil && (ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsUnspecified() || ip.IsMulticast()) {
		return Error{"不能访问本机或局域网地址"}
	}
	return nil
}

const userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 Reader"

func (c *Client) get(ctx context.Context, raw, accept string, limit int64) ([]byte, string, string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, "", "", Error{"链接无效"}
	}
	if err = c.checkURL(u); err != nil {
		return nil, "", "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, "", "", Error{"链接无效"}
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", accept)
	req.Header.Set("Accept-Language", "en,zh;q=0.8")
	res, err := c.HTTP.Do(req)
	if err != nil {
		var e Error
		if errors.As(err, &e) {
			return nil, "", "", e
		}
		if ctx.Err() != nil {
			return nil, "", "", ctx.Err()
		}
		return nil, "", "", Error{fmt.Sprintf("无法连接 %s，请检查网络或代理", u.Host)}
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotFound || res.StatusCode == http.StatusGone {
		return nil, "", "", ErrNotFound
	}
	if res.StatusCode == http.StatusTooManyRequests {
		return nil, "", "", rateLimitError{Error{fmt.Sprintf("%s 服务商限制了请求频率，请稍后重试", u.Host)}}
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil, "", "", Error{fmt.Sprintf("%s 返回 %d", u.Host, res.StatusCode)}
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if err != nil {
		return nil, "", "", Error{fmt.Sprintf("从 %s 下载未完成", u.Host)}
	}
	if int64(len(data)) > limit {
		return nil, "", "", Error{fmt.Sprintf("文件超过 %d MB", limit>>20)}
	}
	return data, res.Header.Get("Content-Type"), res.Request.URL.String(), nil
}

func (c *Client) pdf(ctx context.Context, raw string) ([]byte, error) {
	data, _, _, err := c.get(ctx, raw, "application/pdf,*/*;q=0.8", c.MaxPDF)
	if err != nil {
		return nil, err
	}
	if !strings.HasPrefix(string(data[:min(len(data), 5)]), "%PDF-") {
		return nil, Error{"链接打开的不是 PDF"}
	}
	return data, nil
}

// splitName turns "Ashish Vaswani" or "Vaswani, Ashish" into given/family;
// names in CJK scripts and single words stay whole.
func splitName(name string) Creator {
	name = strings.Join(strings.Fields(name), " ")
	if name == "" {
		return Creator{}
	}
	if family, given, ok := strings.Cut(name, ","); ok && strings.TrimSpace(given) != "" {
		return Creator{Given: strings.TrimSpace(given), Family: strings.TrimSpace(family)}
	}
	if strings.ContainsFunc(name, func(r rune) bool { return unicode.Is(unicode.Han, r) }) || !strings.Contains(name, " ") {
		return Creator{Name: name}
	}
	i := strings.LastIndex(name, " ")
	return Creator{Given: name[:i], Family: name[i+1:]}
}

func words(text string) map[string]bool {
	out := map[string]bool{}
	for _, w := range strings.FieldsFunc(strings.ToLower(text), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) }) {
		out[w] = true
	}
	return out
}

// TitleSimilarity is the Jaccard overlap of the two titles' words.
func TitleSimilarity(a, b string) float64 {
	x, y := words(a), words(b)
	if len(x) == 0 || len(y) == 0 {
		return 0
	}
	both := 0
	for w := range x {
		if y[w] {
			both++
		}
	}
	return float64(both) / float64(len(x)+len(y)-both)
}

func filename(raw, fallback string) string {
	u, err := url.Parse(raw)
	name := ""
	if err == nil {
		name = u.Path[strings.LastIndex(u.Path, "/")+1:]
		if unescaped, e := url.PathUnescape(name); e == nil {
			name = unescaped
		}
	}
	name = strings.Map(func(r rune) rune {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '.' || r == '-' || r == '_' {
			return r
		}
		return '_'
	}, name)
	if len([]rune(name)) > 80 {
		name = string([]rune(name)[:80])
	}
	if strings.Trim(name, "._") == "" || strings.EqualFold(name, ".pdf") {
		name = fallback
	}
	if !strings.HasSuffix(strings.ToLower(name), ".pdf") {
		name += ".pdf"
	}
	return name
}

// overlay copies non-empty fields of b over a.
func overlay(a, b Metadata) Metadata {
	pick := func(x, y string) string {
		if y != "" {
			return y
		}
		return x
	}
	a.Title = pick(a.Title, b.Title)
	a.ItemType = pick(a.ItemType, b.ItemType)
	if len(b.Creators) > 0 {
		a.Creators = b.Creators
	}
	a.Date = pick(a.Date, b.Date)
	a.Venue = pick(a.Venue, b.Venue)
	a.Volume = pick(a.Volume, b.Volume)
	a.Issue = pick(a.Issue, b.Issue)
	a.Pages = pick(a.Pages, b.Pages)
	a.Publisher = pick(a.Publisher, b.Publisher)
	a.DOI = pick(a.DOI, b.DOI)
	a.ArXiv = pick(a.ArXiv, b.ArXiv)
	a.ISBN = pick(a.ISBN, b.ISBN)
	a.URL = pick(a.URL, b.URL)
	a.Abstract = pick(a.Abstract, b.Abstract)
	return a
}

func clean(text string) string { return strings.Join(strings.Fields(text), " ") }
