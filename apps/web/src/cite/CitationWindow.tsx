import { useEffect } from "react";
import { api } from "@neoread/api";
import { Toaster } from "@neoread/ui/components/sonner";
import { useResolvedTheme } from "../appearance";
import { useReaderStore } from "../store";
import { CiteHost } from "./CiteHost";

export function CitationWindow() {
  const theme = useResolvedTheme(useReaderStore((state) => state.theme));
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme.mode === "dark");
    root.dataset.theme = theme.mode;
  }, [theme.mode]);
  useEffect(() => {
    document.documentElement.dataset.citationWindow = "";
  }, []);
  useEffect(() => {
    void api
      .settings()
      .then((settings) => useReaderStore.getState().setTheme(settings))
      .catch(() => {});
  }, []);
  return (
    <>
      <CiteHost standalone />
      <Toaster theme={theme.mode === "dark" ? "dark" : "light"} />
    </>
  );
}
