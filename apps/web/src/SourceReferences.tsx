import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChatCitationNavigation } from "./chat/citations";
import { ArrowUpRight, Loader2 } from "lucide-react";
import type {
  DocumentLocation,
  Message,
  ReaderAdapter,
  TOCItem,
} from "@reader/core";
import { Button } from "@reader/ui/components/button";
import { api } from "@reader/api";
import {
  referenceCards,
  referenceLabel,
  type ReferenceCard,
} from "./references";

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
