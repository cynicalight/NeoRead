/// <reference types="chrome" />
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { detectPage, type Candidate, type Detection } from "./detect";
const bridge = "http://127.0.0.1:17841";
const outdatedReaderMessage = "请重启 pnpm desktop，更新本机分类和标签接口";
const cleanDate = (value: unknown) => {
  const match = String(value || "").match(
    /^(\d{4})(?:[-/](\d{1,2})(?:[-/](\d{1,2}))?)?/,
  );
  return match
    ? [match[1], match[2]?.padStart(2, "0"), match[3]?.padStart(2, "0")]
        .filter(Boolean)
        .join("-")
    : "";
};
function App() {
  const [secret, setSecret] = useState("");
  const [items, setItems] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [folder, setFolder] = useState("");
  const [tags, setTags] = useState("");
  const [folders, setFolders] = useState<string[]>([]);
  const [existingTags, setExistingTags] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<
    "neutral" | "success" | "error"
  >("neutral");
  const [outcomes, setOutcomes] = useState<{ ok: boolean; text: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [largeConfirmation, setLargeConfirmation] = useState<{
    resolve: (library: "papers" | "books") => void;
  }>();
  useEffect(() => {
    void (async () => {
      try {
        const stored = await chrome.storage.local.get("secret");
        let credential = typeof stored.secret === "string" ? stored.secret : "";
        let response = credential
          ? await fetch(bridge + "/v1/labels", {
              headers: { Authorization: `Bearer ${credential}` },
            })
          : null;
        if (!response || response.status === 401) {
          const session = await fetch(bridge + "/v1/session", {
            method: "POST",
          });
          if (!session.ok) throw Error("无法连接 Reader");
          credential = (await session.json()).secret;
          await chrome.storage.local.set({ secret: credential });
          response = await fetch(bridge + "/v1/labels", {
            headers: { Authorization: `Bearer ${credential}` },
          });
        }
        if (response.status === 404) throw Error(outdatedReaderMessage);
        if (!response.ok) throw Error("无法读取 Reader 论文库");
        const labels = (await response.json()) as {
          folders: string[];
          tags: string[];
        };
        setFolders(labels.folders);
        setExistingTags(labels.tags);
        setSecret(credential);
      } catch (error) {
        setMessage(
          error instanceof Error && error.message === outdatedReaderMessage
            ? error.message
            : "请先打开 Reader 桌面应用",
        );
        setMessageTone("error");
      }
    })();
  }, []);
  useEffect(() => {
    void (async () => {
      try {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (!tab?.id) throw Error("无法读取当前标签页");
        if (tab.url?.toLowerCase().includes(".pdf")) {
          setItems([
            {
              title: tab.title || "PDF",
              sourceUrl: tab.url,
              pdfUrl: tab.url,
              metadata: {
                title: tab.title || "PDF",
                url: tab.url,
                itemType: "journal",
              },
              snapshot: "",
            },
          ]);
          setSelected([0]);
          return;
        }
        const result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: detectPage,
        });
        const detection = result[0]?.result as Detection | undefined;
        if (!detection?.items.length) throw Error("未识别到论文");
        setItems(detection.items);
        setSelected(detection.items.map((_, i) => i));
      } catch (error) {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (tab?.url && /^https?:\/\//.test(tab.url)) {
          // Chrome's built-in PDF viewer does not allow page script injection.
          // The worker validates the PDF signature before sending anything to Reader.
          setItems([
            {
              title: tab.title || "PDF",
              sourceUrl: tab.url,
              pdfUrl: tab.url,
              metadata: {
                title: tab.title || "PDF",
                url: tab.url,
                itemType: "journal",
              },
              snapshot: "",
            },
          ]);
          setSelected([0]);
          setMessage("无法读取页面内容；如果当前标签页是 PDF，仍可尝试收录。");
          setMessageTone("neutral");
        } else {
          setMessage((error as Error).message || "无法读取此页面");
          setMessageTone("error");
        }
      }
    })();
  }, []);
  async function prepare(candidate: Candidate): Promise<Candidate> {
    if (
      candidate.pdfUrl === candidate.sourceUrl &&
      (!candidate.snapshot || /\.pdf(?:$|[?#])/i.test(candidate.sourceUrl))
    )
      return {
        ...candidate,
        metadata: {
          ...candidate.metadata,
          title: candidate.title.slice(0, 300),
        },
      };
    let page: Document;
    if (candidate.snapshot) {
      page = new DOMParser().parseFromString(candidate.snapshot, "text/html");
    } else {
      const response = await fetch(candidate.sourceUrl, {
        credentials: "include",
      });
      if (!response.ok) throw Error(`页面读取失败 (${response.status})`);
      page = new DOMParser().parseFromString(
        await response.text(),
        "text/html",
      );
    }
    const meta = (name: string) =>
      (
        page.querySelector(
          `meta[name="${name}"],meta[property="${name}"]`,
        ) as HTMLMetaElement | null
      )?.content?.trim() || "";
    const absolute = (value: string) => {
      if (!value.trim()) return "";
      try {
        const u = new URL(value, candidate.sourceUrl);
        return ["http:", "https:"].includes(u.protocol) ? u.href : "";
      } catch {
        return "";
      }
    };
    const arxiv =
      meta("citation_arxiv_id") ||
      (candidate.sourceUrl.includes("arxiv.org")
        ? (candidate.sourceUrl.match(/\/(?:abs|pdf)\/([^/?#]+)/) || [])[1]
        : "") ||
      "";
    let pdf =
      candidate.pdfUrl ||
      absolute(meta("citation_pdf_url")) ||
      absolute(
        (
          page.querySelector(
            'a[href$=".pdf"],a[href*="/pdf/"],link[type="application/pdf"]',
          ) as HTMLAnchorElement | null
        )?.href || "",
      ) ||
      (arxiv ? `https://arxiv.org/pdf/${arxiv}` : "");
    const title = (meta("citation_title") || candidate.title).slice(0, 300);
    const authors = Array.from(
      page.querySelectorAll<HTMLMetaElement>('meta[name="citation_author"]'),
    )
      .map((a) => ({ name: a.content.trim() }))
      .filter((a) => a.name);
    const rawDOI = String(meta("citation_doi") || candidate.metadata.doi || "")
      .replace(/^doi:/i, "")
      .trim();
    const metadata: Record<string, unknown> = {
      ...candidate.metadata,
      title,
      url: candidate.sourceUrl,
      itemType: arxiv ? "preprint" : "journal",
      date: cleanDate(
        meta("citation_date") ||
          meta("citation_publication_date") ||
          candidate.metadata.date,
      ),
      doi: /^10\.\d{4,9}\/\S+$/.test(rawDOI) ? rawDOI : "",
      arxiv,
      venue: String(
        meta("citation_journal_title") ||
          meta("citation_conference_title") ||
          candidate.metadata.venue ||
          "",
      ).slice(0, 500),
      abstract: String(
        meta("citation_abstract") || candidate.metadata.abstract || "",
      ).slice(0, 20000),
    };
    if (authors.length) metadata.creators = authors;
    if (metadata.doi) {
      try {
        const response = await fetch(
          `https://api.crossref.org/works/${encodeURIComponent(String(metadata.doi))}`,
        );
        if (response.ok) {
          const { message: work } = await response.json();
          if (work && typeof work === "object") {
            if (
              !meta("citation_title") &&
              Array.isArray(work.title) &&
              work.title[0]
            )
              metadata.title = String(work.title[0]).slice(0, 300);
            if (!authors.length && Array.isArray(work.author))
              metadata.creators = work.author
                .map((a: { given?: string; family?: string }) => ({
                  name: [a.given, a.family].filter(Boolean).join(" "),
                }))
                .filter((a: { name: string }) => a.name);
            if (!metadata.venue && Array.isArray(work["container-title"]))
              metadata.venue = String(work["container-title"][0] || "").slice(
                0,
                500,
              );
            if (!metadata.date) {
              const parts = work.published?.["date-parts"]?.[0];
              if (Array.isArray(parts))
                metadata.date = cleanDate(parts.join("-"));
            }
            if (!pdf && Array.isArray(work.link)) {
              const link = work.link.find(
                (x: { "content-type"?: string; URL?: string }) =>
                  x["content-type"] === "application/pdf",
              );
              pdf = absolute(link?.URL || "");
            }
          }
        }
      } catch {
        /* A DOI lookup is optional when the publisher page already has data. */
      }
    }
    const main = page.querySelector("main,article") || page.body;
    let snapshot = main?.outerHTML || "";
    const snapshotWarnings: string[] = [];
    // Embed images within the snapshot size budget for offline reading.
    const clone = main?.cloneNode(true) as Element | undefined;
    if (clone) {
      clone
        .querySelectorAll(
          "script,style,iframe,object,embed,form,svg,template,noscript",
        )
        .forEach((node) => node.remove());
      let omittedImages = 0;
      for (const img of Array.from(
        clone.querySelectorAll<HTMLImageElement>("img"),
      )) {
        try {
          const src = absolute(
            img.getAttribute("src") || img.getAttribute("data-src") || "",
          );
          if (!src) {
            omittedImages++;
            img.removeAttribute("src");
            continue;
          }
          const response = await fetch(src, { credentials: "include" });
          if (!response.ok) throw Error("image fetch failed");
          const blob = await response.blob();
          if (
            !blob.type.match(/^image\/(png|jpeg|webp|gif)$/) ||
            blob.size > 2_000_000
          )
            throw Error("image too large or unsupported");
          const data = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
          if (
            new TextEncoder().encode(clone.outerHTML).length + data.length >
            10 * 1024 * 1024
          )
            throw Error("snapshot size limit");
          img.src = data;
        } catch {
          omittedImages++;
          img.removeAttribute("src");
        }
      }
      if (omittedImages)
        snapshotWarnings.push(`${omittedImages} 张图片未能离线保存`);
      snapshot = clone.outerHTML;
    }
    if (new TextEncoder().encode(snapshot).length > 10 * 1024 * 1024) {
      snapshot = "";
      snapshotWarnings.push("网页快照超过 10 MB，未保存快照");
    }
    return {
      ...candidate,
      title: String(metadata.title),
      pdfUrl: pdf,
      metadata,
      snapshot,
      snapshotWarnings,
    };
  }
  async function save() {
    if (!secret || selected.length === 0) return;
    setBusy(true);
    setMessage("");
    setMessageTone("neutral");
    setOutcomes([]);
    let success = 0;
    const completed: { ok: boolean; text: string }[] = [];
    const failures: string[] = [];
    const warnings: string[] = [];
    try {
      const allowed = await chrome.permissions.request({
        origins: ["https://*/*", "http://*/*"],
      });
      if (!allowed) throw Error("需要网站访问权限才能读取论文页面和 PDF");
      for (const index of selected) {
        const item = items[index];
        setMessage(
          `正在收录 ${success + failures.length + 1}/${selected.length}：${item.title}`,
        );
        setMessageTone("neutral");
        try {
          const prepared = await prepare(item);
          const request = {
            type: "save",
            candidate: prepared,
            folders: folder ? [folder] : [],
            tags: tags
              .split(/[,，]/)
              .map((x) => x.trim())
              .filter(Boolean),
          };
          let result = (await chrome.runtime.sendMessage(request)) as {
            ok: boolean;
            error?: string;
            code?: string;
            pages?: number;
            warnings?: string[];
          };
          if (result.code === "large-paper") {
            const library = await new Promise<"papers" | "books">((resolve) =>
              setLargeConfirmation({ resolve }),
            );
            setLargeConfirmation(undefined);
            result = await chrome.runtime.sendMessage({
              ...request,
              allowLarge: true,
              library,
            });
          }
          if (result.ok) {
            success++;
            completed.push({ ok: true, text: `✓ ${item.title}` });
            if (prepared.snapshotWarnings?.length)
              warnings.push(
                `${item.title}：${prepared.snapshotWarnings.join("；")}`,
              );
            if (result.warnings?.length)
              warnings.push(`${item.title}：${result.warnings.join("；")}`);
          } else {
            const failure = `${item.title}：${result.error || "失败"}`;
            failures.push(failure);
            completed.push({ ok: false, text: `✕ ${failure}` });
          }
        } catch (error) {
          const failure = `${item.title}：${(error as Error).message}`;
          failures.push(failure);
          completed.push({ ok: false, text: `✕ ${failure}` });
        }
      }
      setMessage(
        `已收录 ${success} 篇，失败 ${failures.length} 篇${warnings.length ? "\n提醒：" + warnings.join("\n") : ""}`,
      );
      setMessageTone(failures.length ? "error" : "success");
      setOutcomes(completed);
    } catch (error) {
      setMessage((error as Error).message);
      setMessageTone("error");
    } finally {
      setBusy(false);
    }
  }
  const tagPrefix = tags.match(/^.*[,，]\s*/)?.[0] || "";
  if (largeConfirmation)
    return (
      <main>
        <h1>检测到 PDF 过大</h1>
        <p>请确认是否是论文？如果是图书类，请导入图书库。</p>
        <div className="row">
          <button onClick={() => largeConfirmation.resolve("books")}>
            不是论文，导入图书库
          </button>
          <button
            className="primary"
            onClick={() => largeConfirmation.resolve("papers")}
          >
            确认是论文，仍然导入论文库
          </button>
        </div>
      </main>
    );
  return (
    <>
      <main>
        <h1>Reader Connector</h1>
        {!secret ? (
          <p>正在连接本机 Reader…</p>
        ) : (
          <>
            <p>
              {items.length > 1
                ? `识别到 ${items.length} 篇，选择要收录的论文。`
                : "保存当前页面的 PDF 论文。"}
            </p>
            {items.map((item, i) => (
              <label className="item" key={item.sourceUrl + i}>
                <input
                  type="checkbox"
                  checked={selected.includes(i)}
                  onChange={(e) =>
                    setSelected((current) =>
                      e.target.checked
                        ? [...current, i]
                        : current.filter((x) => x !== i),
                    )
                  }
                />
                <span>
                  <strong>{item.title}</strong>
                  <small>
                    {item.pdfUrl ? "已发现 PDF" : "将尝试在论文页面查找 PDF"}
                  </small>
                </span>
              </label>
            ))}
            <label htmlFor="folder">分类</label>
            <input
              id="folder"
              list="reader-folders"
              type="text"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              placeholder="可选"
            />
            <datalist id="reader-folders">
              {folders.map((f) => (
                <option value={f} key={f} />
              ))}
            </datalist>
            <label htmlFor="tags">标签</label>
            <input
              id="tags"
              list="reader-tags"
              type="text"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="用逗号分隔，可选"
            />
            <datalist id="reader-tags">
              {existingTags.map((tag) => (
                <option value={`${tagPrefix}${tag}`} key={tag} />
              ))}
            </datalist>
            <p className="muted">
              首次收录时，Chrome 会请求网站访问权限，用于读取所选页面、PDF
              和快照图片。
            </p>
          </>
        )}
        {message && (
          <div className={`status ${messageTone}`}>
            {message}
            {outcomes.map((outcome, index) => (
              <div className={outcome.ok ? "success" : "error"} key={index}>
                {outcome.text}
              </div>
            ))}
          </div>
        )}
      </main>
      {secret && (
        <div className="footer">
          <button
            className="primary"
            style={{ width: "100%" }}
            disabled={busy || !selected.length}
            onClick={() => void save()}
          >
            {busy ? "正在处理…" : `收录 ${selected.length} 篇到 Reader`}
          </button>
        </div>
      )}
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
