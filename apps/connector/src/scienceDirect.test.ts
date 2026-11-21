import { expect, it } from "vitest";
import { isScienceDirectPDFLocation, scienceDirectDownloadURL } from "./scienceDirect";

const article = "https://www.sciencedirect.com/science/article/pii/S2352711024000111";
const pdf = `${article}/pdfft?download=true`;
const cdn = "https://pdf.sciencedirectassets.com/271730/1-s2.0-S2352711024X00022/1-s2.0-S2352711024000111/main.pdf";

it("derives the same query-free article identity from detail or abstract URLs", () => {
  expect(scienceDirectDownloadURL(article)).toBe(pdf);
  expect(scienceDirectDownloadURL(
    "https://sciencedirect.com/science/article/abs/pii/S2352711024000111/?__cf_chl_tk=temp#abstract",
  )).toBe(pdf);
});

it.each([
  "not a URL",
  article.replace("https:", "http:"),
  article.replace("www.sciencedirect.com", "www.sciencedirect.com:8080"),
  article.replace("www.sciencedirect.com", "www.sciencedirect.com.example.com"),
  article.replace("www.sciencedirect.com", "evil@www.sciencedirect.com"),
  article.replace("/science/article/", "/search/article/"),
  article.replace("S2352711024000111", "not-a-pii"),
  pdf,
])("does not derive a PDF link for %s", (value) => {
  expect(scienceDirectDownloadURL(value)).toBeNull();
});

it("recognizes only supported, same-article publisher PDF locations", () => {
  expect(isScienceDirectPDFLocation(pdf, article)).toBe(true);
  expect(isScienceDirectPDFLocation(`${cdn}?download=1#page=2`, article)).toBe(true);
  for (const location of [
    article,
    `${article}/pdf`,
    `${article}/pdfft/other`,
    `${pdf}&%5f%5fcf_chl_tk=temporary`,
    "https://www.sciencedirect.com/cdn-cgi/challenge-platform/test",
    "https://www.sciencedirect.com/user/login?next=" + encodeURIComponent(pdf),
    cdn.replace("https:", "http:"),
    cdn.replace(".com/", ".com:4433/"),
    cdn.replace(".com/", ".com.example.net/"),
    cdn.replace("pdf.sciencedirectassets.com", "other.sciencedirectassets.com"),
    cdn.replace("pdf.sciencedirectassets.com", "username:password@pdf.sciencedirectassets.com"),
    cdn.replace("main.pdf", "supplement.pdf"),
    cdn.replace("S2352711024000111", "S2352711024000222"),
    cdn.replace("S2352711024X00022", "S2352711024000111").replace("S2352711024000111/main.pdf", "S2352711024000222/main.pdf"),
  ]) expect(isScienceDirectPDFLocation(location, article), location).toBe(false);
});
