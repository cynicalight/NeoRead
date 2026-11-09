import { useEffect, useRef, useState } from "react";
import type { TranslationBlock } from "@neoread/core";
import { api } from "@neoread/api";
export function useTranslations(
  documentId: string,
  hrefs?: string[],
  active = true,
) {
  const [translations, setTranslations] = useState<TranslationBlock[]>([]);
  const [error, setError] = useState("");
  const scope = hrefs?.join("\0");
  const previousDocument = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (previousDocument.current !== documentId || scope === "")
      setTranslations([]);
    previousDocument.current = documentId;
    setError("");
    if (!active || scope === "") return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = 500;
    const subscribe = async () => {
      try {
        await api.translationStream(
          documentId,
          controller.signal,
          (event) => {
            if (controller.signal.aborted) return;
            retryDelay = 500;
            setError("");
            if (event.event === "snapshot") setTranslations(event.data);
            else {
              setTranslations((current) => {
                const index = current.findIndex(
                  (b) => b.blockId === event.data.blockId,
                );
                if (index < 0) return [...current, event.data];
                return current.map((b, i) => (i === index ? event.data : b));
              });
            }
          },
          scope?.split("\0"),
        );
      } catch (e) {
        if (!controller.signal.aborted) setError((e as Error).message);
      } finally {
        if (!controller.signal.aborted) {
          timer = setTimeout(() => void subscribe(), retryDelay);
          retryDelay = Math.min(retryDelay * 2, 5000);
        }
      }
    };
    void subscribe();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [documentId, scope, active]);
  return { translations, error };
}
