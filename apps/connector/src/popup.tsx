/// <reference types="chrome" />
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  detectPage,
  pdfTabCandidate,
  withPDFTitle,
  type Candidate,
  type Detection,
} from "./detect";
import { prepareCandidate } from "./prepare";
import { TagPicker } from "./TagPicker";
const bridge = "http://127.0.0.1:17841";
const outdatedAppMessage = "请重启 pnpm desktop，更新本机分类和标签接口";
function App() {
  const [secret, setSecret] = useState("");
  const [items, setItems] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [folder, setFolder] = useState("");
  const [tags, setTags] = useState<string[]>([]);
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
          if (!session.ok) throw Error("无法连接 NeoRead");
          credential = (await session.json()).secret;
          await chrome.storage.local.set({ secret: credential });
          response = await fetch(bridge + "/v1/labels", {
            headers: { Authorization: `Bearer ${credential}` },
          });
        }
        if (response.status === 404) throw Error(outdatedAppMessage);
        if (!response.ok) throw Error("无法读取 NeoRead 论文库");
        const labels = (await response.json()) as {
          folders: string[];
          tags: string[];
        };
        setFolders(labels.folders);
        setExistingTags(labels.tags);
        setSecret(credential);
      } catch (error) {
        setMessage(
          error instanceof Error && error.message === outdatedAppMessage
            ? error.message
            : "请先打开 NeoRead 桌面应用",
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
          setItems([pdfTabCandidate(tab.url, tab.title || "PDF")]);
          setSelected([0]);
          return;
        }
        const result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: detectPage,
        });
        const detection = result[0]?.result as Detection | undefined;
        if (!detection?.items.length) throw Error("未识别到论文");
        setItems(
          detection.items.map((item) =>
            detection.kind === "single"
              ? { ...withPDFTitle(item), tabId: tab.id }
              : item,
          ),
        );
        setSelected(detection.items.map((_, i) => i));
      } catch (error) {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (tab?.url && /^https?:\/\//.test(tab.url)) {
          // Chrome's built-in PDF viewer does not allow page script injection.
          // The worker validates the PDF signature before sending anything to NeoRead.
          setItems([pdfTabCandidate(tab.url, tab.title || "PDF")]);
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
          const prepared = await prepareCandidate(item);
          const request = {
            type: "save",
            candidate: prepared,
            folders: folder ? [folder] : [],
            tags,
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
        <h1>NeoRead Connector</h1>
        {!secret ? (
          <p>正在连接本机 NeoRead…</p>
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
              list="neoread-folders"
              type="text"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              placeholder="可选"
            />
            <datalist id="neoread-folders">
              {folders.map((f) => (
                <option value={f} key={f} />
              ))}
            </datalist>
            <TagPicker
              options={existingTags}
              value={tags}
              onChange={setTags}
              disabled={busy}
            />
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
            {busy
              ? "正在处理…"
              : `收录 ${selected.length} 篇到 NeoRead`}
          </button>
        </div>
      )}
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
