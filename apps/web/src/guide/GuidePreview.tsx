import { useEffect, useState } from "react";
import { Button } from "@neoread/ui/components/button";
import { TooltipProvider } from "@neoread/ui/components/tooltip";
import { GuideDialog, ReleaseNotesDialog } from "./GuideDialog";
import { releaseNotes } from "./releases";
import { guideTopics } from "./topics";

const themes = ["light", "sepia", "dark"] as const;

/**
 * Development preview of the guide and release notes. The guided tour needs
 * the real app; start it from the guide there.
 */
export default function GuidePreview() {
  const [theme, setTheme] = useState<(typeof themes)[number]>("light");
  const [view, setView] = useState<"guide" | "release" | null>(
    new URLSearchParams(location.search).get("view") === "release"
      ? "release"
      : "guide",
  );
  const [topic, setTopic] = useState(() => {
    const requested = new URLSearchParams(location.search).get("topic");
    return (
      guideTopics.find((topic) => topic.id === requested)?.id ??
      guideTopics[0].id
    );
  });
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    root.dataset.theme = theme;
    root.style.colorScheme = theme === "dark" ? "dark" : "light";
  }, [theme]);
  const [version, items] = Object.entries(releaseNotes).at(-1) ?? ["", []];
  return (
    <TooltipProvider>
      <div className="app flex-col gap-4 p-6">
        <div className="flex flex-wrap gap-2">
          {themes.map((value) => (
            <Button
              key={value}
              variant={theme === value ? "default" : "outline"}
              onClick={() => setTheme(value)}
            >
              {value}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setView("guide")}>
            指南
          </Button>
          <Button variant="outline" onClick={() => setView("release")}>
            更新内容
          </Button>
        </div>
      </div>
      <GuideDialog
        open={view === "guide"}
        onOpenChange={(open) => setView(open ? "guide" : null)}
        topic={topic}
        onTopicChange={setTopic}
        onAction={() => setView(null)}
      />
      <ReleaseNotesDialog
        open={view === "release"}
        version={version}
        items={items}
        onClose={() => setView(null)}
        onShowTopic={(id) => {
          setTopic(id);
          setView("guide");
        }}
      />
    </TooltipProvider>
  );
}
