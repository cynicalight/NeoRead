import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChatCitationNavigation } from "./chat/citations";
import { ArrowUpRight, Loader2 } from "lucide-react";
import type {
  DocumentLocation,
  Message,
  ReaderAdapter,
  TOCItem,
} from "@neoread/core";
import { Button } from "@neoread/ui/components/button";
import { api } from "@neoread/api";
import {
  referenceCards,
  referenceLabel,
  type ReferenceCard,
} from "./references";
import type { LiveReadSources } from "./chat/chat-session";

/**
 * Citations of an unsaved answer link only to passages its current attempt has
 * read. Each click asks the server for that passage again and navigates only
 * when it is still valid and this answer, attempt and panel are still current.
 */
export function LiveSourceReferences({
  documentId,
  sessionId,
  sources,
  adapter,
  onNavigate,
  children,
}: {
  documentId: string;
  sessionId?: string;
  sources?: LiveReadSources;
  adapter?: ReaderAdapter;
  onNavigate: (location: DocumentLocation, text: string) => Promise<void>;
  children: ReactNode;
}) {
  const [error, setError] = useState("");
  const request = useRef<{ serial: number; abort?: AbortController }>({
    serial: 0,
  });
  const runId = sources?.runId,
    attemptId = sources?.attemptId;
  useEffect(() => {
    setError("");
    const current = request.current;
    return () => {
      // Leaving the panel or starting another run/attempt drops late results.
      current.serial++;
      current.abort?.abort();
      current.abort = undefined;
    };
  }, [documentId, sessionId, runId, attemptId, adapter]);
  const latest = useRef({ adapter, onNavigate });
  latest.current = { adapter, onNavigate };
  const keys = sources?.keys;
  const value = useMemo(() => {
    if (!sessionId || !runId || !attemptId || !keys?.length) return;
    return {
      sourceIds: keys,
      navigate: (source: string) => {
        const current = request.current;
        current.abort?.abort();
        const controller = new AbortController();
        const serial = ++current.serial;
        current.abort = controller;
        const live = () =>
          serial === current.serial && !controller.signal.aborted;
        setError("");
        void (async () => {
          try {
            const reference = await api.liveReadSource(
              documentId,
              sessionId,
              runId,
              attemptId,
              source,
              controller.signal,
            );
            if (!live()) return;
            const { adapter, onNavigate } = latest.current;
            if (!adapter) throw new Error("阅读器尚未就绪，暂时无法跳转。");
            if (!reference.location)
              throw new Error("该来源缺少原文位置，无法跳转。");
            await onNavigate(reference.location, reference.text);
            if (live())
              adapter.flashReference?.(reference.location, reference.text);
          } catch (e) {
            if (live()) setError((e as Error).message);
          } finally {
            if (current.abort === controller) current.abort = undefined;
          }
        })();
      },
    };
  }, [documentId, sessionId, runId, attemptId, keys]);
  return (
    <ChatCitationNavigation.Provider value={value}>
      {children}
      {error && (
        <p role="alert" className="reference-error">
          {error}
        </p>
      )}
    </ChatCitationNavigation.Provider>
  );
}

export function SourceReferences({
  message,
  toc,
  adapter,
  onNavigate,
  children,
}: {
  message: Message;
  toc: TOCItem[];
  adapter?: ReaderAdapter;
  onNavigate: (location: DocumentLocation, text: string) => Promise<void>;
  children?: ReactNode;
}) {
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState("");
  const [candidates, setCandidates] = useState<ReferenceCard[]>();
  const request = useRef(0);
  useEffect(() => {
    setPending(undefined);
    setError("");
    setCandidates(undefined);
    return () => {
      request.current++;
    };
  }, [message.id, adapter]);
  const cards = referenceCards(message, toc);
  if (!cards.length) return children ?? null;
  const choose = async (card: ReferenceCard) => {
    if (!adapter || pending) return;
    const serial = ++request.current;
    setPending(card.id);
    setError("");
    try {
      if (card.sourceId) {
        await api.validateEvidence(
          message.documentId,
          message.id,
          card.sourceId,
        );
        if (serial !== request.current) return;
      }
      let target = card.location;
      if (!target) {
        // Search the original excerpt, not a model-generated paraphrase.
        const text = card.text.replace(/\s+/g, " ").trim();
        let matches = await adapter.search(text.slice(0, 80));
        if (!matches.length) matches = await adapter.search(text.slice(0, 40));
        if (serial !== request.current) return;
        if (!matches.length)
          throw new Error("未找到对应原文，可在书内搜索中查找。");
        if (matches.length > 1) {
          setCandidates(
            matches.map((match, i) => ({
              ...card,
              id: `match-${i}`,
              label: referenceLabel(match.location, toc),
              location: match.location,
            })),
          );
          return;
        }
        target = matches[0].location;
      }
      await onNavigate(target, card.text);
      if (serial === request.current) {
        adapter.flashReference?.(target, card.text);
        setCandidates(undefined);
      }
    } catch (e) {
      if (serial === request.current) setError((e as Error).message);
    } finally {
      if (serial === request.current) setPending(undefined);
    }
  };
  return (
    <ChatCitationNavigation.Provider
      value={{
        sourceIds: cards.flatMap((card) =>
          card.sourceId ? [card.sourceId] : [],
        ),
        previews: Object.fromEntries(
          cards.flatMap((card) =>
            card.sourceId
              ? [[card.sourceId, { text: card.text, label: card.label }]]
              : [],
          ),
        ),
        navigate: (sourceId) => {
          const card = cards.find((card) => card.sourceId === sourceId);
          if (card) void choose(card);
        },
      }}
    >
      {children}
      <div className="chat-user-references">
        {candidates && <p className="reference-prompt">选择原文位置</p>}
        {(!children || candidates) && (
          <div className="reference-list" role="list" aria-label="原文引用列表">
            {(candidates || cards).map((card) => (
              <div role="listitem" key={card.id}>
                <Button
                  variant="ghost"
                  className="reference-card"
                  disabled={!adapter || !!pending}
                  onClick={() => void choose(card)}
                >
                  <span className="reference-card-heading">
                    <span title={card.label}>引用原文 · {card.label}</span>
                    {pending === card.id ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <ArrowUpRight className="size-3" />
                    )}
                  </span>
                  <span className="reference-card-excerpt">{card.text}</span>
                </Button>
              </div>
            ))}
          </div>
        )}
        {error && (
          <p role="alert" className="reference-error">
            {error}
          </p>
        )}
        {candidates && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              request.current++;
              setCandidates(undefined);
              setError("");
            }}
          >
            返回引用列表
          </Button>
        )}
      </div>
    </ChatCitationNavigation.Provider>
  );
}
