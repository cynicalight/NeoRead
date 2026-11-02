import ReactDOM from "react-dom/client";
import { configureAPI } from "@neoread/api";
import { App } from "./App";
import { installCloseFlush } from "./close-flush";
import { AppCrash, ErrorBoundary } from "./ErrorBoundary";
import "./style.css";
import { installDiagnostics } from "./diagnostics";
import { installMotionPreference } from "./motion";
import { installScrollbars } from "./scrollbars";
import { migrateReaderPreferences } from "./legacy-preferences";
import { initialDesktopTheme } from "./appearance";
import { useReaderStore } from "./store";
migrateReaderPreferences();
if (window.neoreadDesktop?.startupAppearance) {
  useReaderStore
    .getState()
    .setTheme(
      initialDesktopTheme(
        window.neoreadDesktop.startupAppearance,
        window.matchMedia("(prefers-color-scheme: dark)").matches,
      ),
    );
}
const removeMotion = installMotionPreference(document);
if (import.meta.hot) import.meta.hot.dispose(removeMotion);
const removeScrollbars = installScrollbars(document);
if (import.meta.hot) import.meta.hot.dispose(removeScrollbars);
const token =
  new URLSearchParams(location.hash.slice(1)).get("token") ||
  sessionStorage.getItem("neoread-session") ||
  "";
if (token) {
  sessionStorage.setItem("neoread-session", token);
  history.replaceState(null, "", location.pathname + location.search);
}
configureAPI(token);
const removeDiagnostics = installDiagnostics(token);
if (import.meta.hot) import.meta.hot.dispose(removeDiagnostics);
const root = ReactDOM.createRoot(document.getElementById("root")!);
if (
  window.neoreadDesktop &&
  new URLSearchParams(location.search).has("libraryRecovery")
) {
  window.neoreadDesktop.onBeforeClose(async () => {});
  void import("./LibraryRecoverySettings").then(({ LibraryRecoverySettings }) =>
    root.render(<LibraryRecoverySettings />),
  );
} else if (
  window.neoreadDesktop &&
  new URLSearchParams(location.search).has("citationWindow")
) {
  void import("./cite/CitationWindow").then(({ CitationWindow }) =>
    root.render(<CitationWindow />),
  );
} else if (
  import.meta.env.DEV &&
  location.pathname === "/__streaming-benchmark"
) {
  void import("./chat/StreamingBenchmark").then(({ default: Benchmark }) =>
    root.render(<Benchmark />),
  );
} else if (import.meta.env.DEV && location.pathname === "/__streaming") {
  void import("./chat/StreamingPreview").then(({ default: Preview }) =>
    root.render(<Preview />),
  );
} else if (import.meta.env.DEV && location.pathname === "/__web-search") {
  void import("./chat/WebSearchPreview").then(({ default: Preview }) =>
    root.render(<Preview />),
  );
} else if (import.meta.env.DEV && location.pathname === "/__link-preview") {
  void import("./LinkPreviewDemo").then(({ default: Preview }) =>
    root.render(<Preview />),
  );
} else if (import.meta.env.DEV && location.pathname === "/__formula-caption") {
  void import("./translation/FormulaCaptionPreview").then(
    ({ default: Preview }) => root.render(<Preview />),
  );
} else if (import.meta.env.DEV && location.pathname === "/__guide") {
  void import("./guide/GuidePreview").then(({ default: Preview }) =>
    root.render(<Preview />),
  );
} else if (import.meta.env.DEV && location.pathname === "/__processing-cover") {
  void import("./CoverProcessingPreview").then(({ default: Preview }) =>
    root.render(<Preview />),
  );
} else {
  const removeCloseFlush = installCloseFlush();
  if (import.meta.hot) import.meta.hot.dispose(removeCloseFlush);
  root.render(
    <ErrorBoundary fallback={<AppCrash />}>
      <App />
    </ErrorBoundary>,
  );
}
