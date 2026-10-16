import { useEffect, useRef, useState } from "react";
import { Button } from "@reader/ui/components/button";
import { RadioGroup, RadioGroupItem } from "@reader/ui/components/radio-group";
import { Input } from "@reader/ui/components/input";

type Candidate = { path: string; name: string };
export function EndNoteSourcePicker({
  busy,
  onConfirm,
}: {
  busy: boolean;
  onConfirm: (path: string) => void;
}) {
  const [phase, setPhase] = useState<"searching" | "found" | "manual">(
    "searching",
  );
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [path, setPath] = useState("");
  const [message, setMessage] = useState("");
  const cancel = useRef<() => void>(() => {});
  useEffect(() => {
    const desktop = window.readerDesktop;
    const id = crypto.randomUUID();
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const stop = () => {
      active = false;
      clearTimeout(timer);
      void desktop?.cancelEndNoteSearch?.(id).catch(() => {});
    };
    cancel.current = stop;
    if (!desktop?.findEndNoteLibraries) {
      setPhase("manual");
      setMessage("请填写 EndNote 文献库在本机的位置。");
      return stop;
    }
    const manual = (message: string) => {
      if (!active) return;
      stop();
      setMessage(message);
      setPhase("manual");
    };
    timer = setTimeout(
      () => manual("未找到 EndNote 文献库，请手动选择或填写位置。"),
      10_000,
    );
    void desktop.findEndNoteLibraries(id).then(
      (result) => {
        if (!active) return;
        stop();
        if (result.candidates.length) {
          setCandidates(result.candidates);
          setPath(
            result.candidates.length === 1 ? result.candidates[0].path : "",
          );
          setPhase("found");
        } else {
          setMessage("未找到 EndNote 文献库，请手动选择或填写位置。");
          setPhase("manual");
        }
      },
      () => manual("无法自动搜索，请手动选择或填写 EndNote 文献库位置。"),
    );
    return stop;
  }, []);
  const manual = () => {
    cancel.current();
    setPhase("manual");
    setMessage("");
    setPath("");
  };
  const choose = async (directory: boolean) => {
    try {
      const selected =
        await window.readerDesktop?.chooseEndNoteLibrary?.(directory);
      if (selected) setPath(selected);
    } catch (e) {
      setMessage((e as Error).message);
    }
  };
  return (
    <div className="grid gap-3">
      {phase === "searching" ? (
        <>
          <div role="status" className="flex items-center gap-2 text-sm">
            <progress
              aria-label="正在搜索 EndNote 文献库"
              className="h-2 w-16"
            />
            正在搜索 EndNote 文献库，最多 10 秒…
          </div>
          <Button variant="outline" onClick={manual}>
            手动选择位置
          </Button>
        </>
      ) : (
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (path.trim() && !busy) onConfirm(path.trim());
          }}
        >
          {message && (
            <p role="status" className="text-sm text-muted-foreground">
              {message}
            </p>
          )}
          {phase === "found" ? (
            <>
              <p className="text-sm">
                找到 {candidates.length} 个 EndNote 文献库，请确认要使用的库。
              </p>
              <RadioGroup
                className="max-h-52 overflow-y-auto"
                aria-label="EndNote 文献库"
                value={path}
                onValueChange={(value) => setPath(String(value))}
                disabled={busy}
              >
                {candidates.map((candidate) => (
                  <label
                    key={candidate.path}
                    className="flex min-w-0 items-start gap-2 rounded-md border p-3 text-sm"
                  >
                    <RadioGroupItem
                      value={candidate.path}
                      aria-label={candidate.name}
                    />
                    <span className="min-w-0">
                      <span className="block font-medium">
                        {candidate.name}
                      </span>
                      <span className="block break-all text-xs text-muted-foreground">
                        {candidate.path}
                      </span>
                    </span>
                  </label>
                ))}
              </RadioGroup>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={manual}
              >
                选择其他位置
              </Button>
            </>
          ) : (
            <>
              <label htmlFor="endnote-path" className="text-sm font-medium">
                EndNote 文献库位置
              </label>
              <Input
                id="endnote-path"
                value={path}
                disabled={busy}
                onChange={(e) => setPath(e.target.value)}
                placeholder=".enl 文件、.enlp 文件包或所在目录"
              />
              {window.readerDesktop?.chooseEndNoteLibrary && (
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void choose(false)}
                  >
                    选择文献库
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void choose(true)}
                  >
                    选择目录
                  </Button>
                </div>
              )}
            </>
          )}
          <p className="text-xs text-muted-foreground">
            先在 EndNote 中保存修改并完全退出，再确认文献库。扫描不会修改
            EndNote 数据。
          </p>
          <Button type="submit" disabled={busy || !path.trim()}>
            {busy ? "扫描中…" : "使用这个文献库"}
          </Button>
        </form>
      )}
    </div>
  );
}
