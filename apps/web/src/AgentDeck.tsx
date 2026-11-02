import { reducedMotion } from "./motion";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  RefreshCw,
  X,
} from "lucide-react";
import { Button } from "@neoread/ui/components/button";
import { cn } from "@neoread/ui/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@neoread/ui/components/dialog";
import type { RecentCall } from "./agentUsage";
import { useDeckTick } from "./useDeckTick";

export type DeckStatus = "ready" | "pending" | "missing" | "failed";

export interface DeckItem {
  id: string;
  title: string;
  subtitle?: string;
  sideStatus?: string;
  icon: ReactNode;
  status: DeckStatus;
  selected?: boolean;
  /** Check results shown at the top right. */
  checks?: ReactNode;
  /** Every check passed: the row folds into one check after a pause. */
  passed?: boolean;
  /** `agent-card` for agents, read by the guided tour. */
  tour: "agent-card";
  /** A control placed beside the detail arrow in the open deck. */
  extra?: ReactNode;
}

const visible = 2;
const settleDelay = 1000;

function useSettled(passed: boolean) {
  const [settled, setSettled] = useState(passed);
  useEffect(() => {
    if (!passed) {
      setSettled(false);
      return;
    }
    const timer = window.setTimeout(() => setSettled(true), settleDelay);
    return () => window.clearTimeout(timer);
  }, [passed]);
  return settled;
}

// Distance between neighbouring cards in the open deck.
function useStep() {
  const measure = () =>
    Math.round(Math.min(124, Math.max(88, window.innerHeight * 0.14)));
  const [step, setStep] = useState(measure);
  useEffect(() => {
    const resize = () => setStep(measure());
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  return step;
}

function CardFace({ item, detail }: { item: DeckItem; detail?: ReactNode }) {
  const settled = useSettled(!!item.passed);
  return (
    <div className="pointer-events-none relative flex h-full gap-4">
      <div className="flex min-w-0 max-w-[45%] shrink-0 flex-col justify-center gap-2">
        <span className="flex min-w-0 items-center gap-3">
          {item.icon}
          <span className="truncate text-lg font-semibold">{item.title}</span>
        </span>
        {item.subtitle && (
          <span className="truncate text-xs text-muted-foreground">
            {item.subtitle}
          </span>
        )}
      </div>
      {item.sideStatus && (
        <span className="ml-auto flex items-center text-xs text-muted-foreground">
          {item.sideStatus}
        </span>
      )}
      <div
        className={cn(
          "flex shrink-0 flex-col items-end justify-between",
          !item.sideStatus && "ml-auto",
        )}
      >
        <div className="agent-checks" data-settled={settled || undefined}>
          {item.checks}
        </div>
        <div className="flex items-end gap-2">{detail}</div>
      </div>
    </div>
  );
}

const cardClass =
  "h-28 rounded-2xl border bg-card p-4 text-card-foreground shadow-sm";

function DeckDetail({
  item,
  load,
  onBack,
}: {
  item: DeckItem;
  load: (id: string, signal: AbortSignal) => Promise<RecentCall[]>;
  onBack: () => void;
}) {
  const [state, setState] = useState<{ calls?: RecentCall[]; error?: string }>(
    {},
  );
  const loader = useRef(load);
  loader.current = load;
  useEffect(() => {
    const controller = new AbortController();
    setState({});
    loader.current(item.id, controller.signal).then(
      (calls) => {
        if (!controller.signal.aborted) setState({ calls });
      },
      (error: Error) => {
        if (!controller.signal.aborted) setState({ error: error.message });
      },
    );
    return () => controller.abort();
  }, [item.id]);
  return (
    <div
      className="agent-deck-detail relative flex max-h-[80vh] w-[min(560px,calc(100%-3rem))] flex-col rounded-2xl border bg-popover text-popover-foreground shadow-lg"
      data-tour="agent-detail"
    >
      <div className="flex items-center gap-3 border-b p-4">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="返回卡片"
          onClick={onBack}
        >
          <ChevronLeft />
        </Button>
        {item.icon}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {item.title}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <h3 className="px-2 pt-1 pb-2 text-xs text-muted-foreground">
          最近调用
        </h3>
        {state.error ? (
          <p className="px-2 pb-3 text-sm text-destructive">{state.error}</p>
        ) : !state.calls ? (
          <p className="flex items-center gap-2 px-2 pb-3 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            正在读取
          </p>
        ) : !state.calls.length ? (
          <p className="px-2 pb-3 text-sm text-muted-foreground">
            暂无调用记录
          </p>
        ) : (
          <ul>
            {state.calls.map((call) => (
              <li
                key={call.id}
                className="flex items-center gap-3 rounded-lg px-2 py-2 text-sm"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    {call.label}
                    {call.failed && (
                      <span className="text-xs text-destructive">失败</span>
                    )}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {[call.target, call.model].filter(Boolean).join(" · ")}
                  </span>
                </span>
                <span className="shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                  {call.amount && (
                    <span className="block text-foreground">{call.amount}</span>
                  )}
                  {new Date(call.at).toLocaleString("zh-CN", {
                    month: "numeric",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * Agent cards stacked into one row. Clicking the stack opens a looping deck
 * over a blurred backdrop, with the chosen card in the middle.
 */
export function AgentDeck({
  items,
  front,
  open,
  onOpenChange,
  onPick,
  onDetail,
  onRefresh,
  refreshing,
  loadCalls,
  panel,
  onPanelClose,
  usable,
}: {
  panel?: ReactNode;
  onPanelClose: () => void;
  usable: (id: string) => boolean;
  items: DeckItem[];
  /** The card on top of the closed stack. */
  front: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Handles a click; true moves the card to the middle. */
  onPick: (id: string) => boolean;
  /** Whether the card's details can open; otherwise it explains why. */
  onDetail: (id: string) => boolean;
  onRefresh: () => void;
  refreshing: boolean;
  loadCalls: (id: string, signal: AbortSignal) => Promise<RecentCall[]>;
}) {
  const sound = useDeckTick();
  const scrollSound = useRef(false);
  const n = items.length;
  const frontIndex = Math.max(
    0,
    items.findIndex((item) => item.id === front),
  );
  const [pos, setPos] = useState({ center: frontIndex, prev: frontIndex });
  const [spread, setSpread] = useState(false);
  const [mounted, setMounted] = useState(open);
  const stackRef = useRef<HTMLDivElement>(null);
  const [origin, setOrigin] = useState({ x: 0, y: 0, width: 560 });
  const [detail, setDetail] = useState<string | null>(null);
  const [panelVisible, setPanelVisible] = useState(false);
  const anchor = useRef(frontIndex);
  const pickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const latest = useRef({ onPick, usable });
  latest.current = { onPick, usable };
  const hadPanel = useRef(false);
  useEffect(() => {
    if (panel) {
      hadPanel.current = true;
      if (reducedMotion()) {
        setPanelVisible(true);
        return;
      }
      const timer = setTimeout(
        () => setPanelVisible(true),
        reducedMotion() ? 0 : 420,
      );
      return () => clearTimeout(timer);
    }
    setPanelVisible(false);
    if (hadPanel.current) {
      hadPanel.current = false;
      if (!latest.current.usable(items[pos.center].id)) {
        const timer = setTimeout(
          () => move(anchor.current),
          reducedMotion() ? 0 : 240,
        );
        return () => clearTimeout(timer);
      }
      anchor.current = pos.center;
    }
  }, [!!panel]);
  useEffect(() => () => clearTimeout(pickTimer.current), []);
  const close = () => {
    if (panel) onPanelClose();
    else onOpenChange(false);
  };
  const step = useStep();
  const wheel = useRef({ direction: 0, lastInput: 0 });
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  useEffect(() => {
    const rect = stackRef.current?.getBoundingClientRect();
    if (rect) {
      setOrigin({
        x: rect.left + rect.width / 2 - window.innerWidth / 2,
        y: rect.top + 56 - window.innerHeight / 2,
        width: rect.width,
      });
    }
    if (!open) {
      scrollSound.current = false;
      sound.pause();
      clearTimeout(pickTimer.current);
      setSpread(false);
      setDetail(null);
      const timer = window.setTimeout(
        () => setMounted(false),
        reducedMotion() ? 0 : 440,
      );
      return () => window.clearTimeout(timer);
    }
    setMounted(true);
    anchor.current = frontIndex;
    setPos({ center: frontIndex, prev: frontIndex });
    // Let the portal paint the gathered cards before changing their transforms.
    // A single frame can be batched with mounting, skipping the starting pose.
    let firstFrame: number | undefined;
    let secondFrame: number | undefined;
    if (reducedMotion() || !window.requestAnimationFrame) setSpread(true);
    else {
      firstFrame = window.requestAnimationFrame(() => {
        secondFrame = window.requestAnimationFrame(() => setSpread(true));
      });
    }
    return () => {
      if (firstFrame !== undefined) window.cancelAnimationFrame(firstFrame);
      if (secondFrame !== undefined) window.cancelAnimationFrame(secondFrame);
    };
    // Only reopen resets the centre; later selection moves it in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Signed shortest distance from centre `c` to card `i` on the loop.
  const offset = (i: number, c: number) => {
    let d = (((i - c) % n) + n) % n;
    if (d > n / 2) d -= n;
    return d;
  };
  const transform = (d: number) =>
    `translateY(calc(-50% + ${d * step}px)) scale(${1 - Math.min(Math.abs(d), 3) * 0.06})`;
  // One continuous spring drives every card; wrapping is spatial, never timed.
  const [position, setPosition] = useState(frontIndex);
  const motion = useRef({ value: frontIndex, target: frontIndex, velocity: 0 });
  const frame = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (open) {
      motion.current = { value: frontIndex, target: frontIndex, velocity: 0 };
      setPosition(frontIndex);
    }
    return () => {
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      frame.current = undefined;
      clearTimeout(wheelTimer.current);
      wheel.current = { direction: 0, lastInput: 0 };
    };
  }, [open]);
  const animateTo = (target: number) => {
    const state = motion.current;
    state.target = target;
    const center = ((Math.round(target) % n) + n) % n;
    setPos((current) => ({ center, prev: current.center }));
    if (reducedMotion()) {
      if (
        scrollSound.current &&
        Math.round(state.value) !== Math.round(state.target)
      )
        sound.tick();
      state.value = Math.round(state.target);
      state.velocity = 0;
      setPosition(state.value);
      return;
    }
    if (frame.current !== undefined) return;
    let previous = performance.now();
    const tick = (now: number) => {
      const dt = Math.min((now - previous) / 1000, 0.032);
      previous = now;
      state.velocity +=
        ((state.target - state.value) * 170 - state.velocity * 26) * dt;
      const previousCard = Math.round(state.value);
      state.value += state.velocity * dt;
      if (scrollSound.current && Math.round(state.value) !== previousCard)
        sound.tick();
      const settled =
        Math.abs(state.target - state.value) < 0.001 &&
        Math.abs(state.velocity) < 0.01;
      if (settled) {
        state.value = state.target;
        state.velocity = 0;
      }
      setPosition(state.value);
      frame.current = settled ? undefined : requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
  };
  const move = (to: number) => {
    clearTimeout(wheelTimer.current);
    wheel.current = { direction: 0, lastInput: 0 };
    const state = motion.current;
    animateTo(Math.round(state.target + offset(to, state.target)));
  };
  const pick = (i: number) => {
    scrollSound.current = false;
    clearTimeout(pickTimer.current);
    move(i);
    const arrive = () => {
      if (latest.current.onPick(items[i].id)) anchor.current = i;
      else if (items[i].id !== "api") move(anchor.current);
    };
    if (reducedMotion() || i === pos.center) arrive();
    else pickTimer.current = setTimeout(arrive, 540);
  };
  const keys = (event: KeyboardEvent) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    move(pos.center + (event.key === "ArrowDown" ? 1 : -1));
  };
  const shown = items.find((item) => item.id === detail);

  return (
    <>
      <div
        ref={stackRef}
        className="agent-stack relative h-[124px]"
        style={{ visibility: mounted ? "hidden" : undefined }}
        data-tour="agent-cards"
      >
        {items.map((item, i) => {
          const depth = (i - frontIndex + n) % n;
          return (
            <div
              key={item.id}
              className={cn(
                cardClass,
                "agent-stack-card absolute inset-x-0 top-0",
              )}
              style={{
                ["--depth" as string]: Math.min(depth, visible),
                zIndex: n - depth,
                opacity: depth > visible ? 0 : 1,
              }}
              data-depth={Math.min(depth, visible + 1)}
              data-tour={open ? undefined : item.tour}
              data-agent={item.tour === "agent-card" ? item.id : undefined}
              data-status={item.tour === "agent-card" ? item.status : undefined}
              data-selected={item.selected || undefined}
              aria-hidden={depth > 0 || undefined}
              inert={depth > 0}
            >
              <CardFace item={item} />
            </div>
          );
        })}
        <Button
          variant="ghost"
          className="absolute inset-0 z-20 h-auto rounded-2xl p-0 hover:bg-transparent dark:hover:bg-transparent"
          aria-label="展开 Agent 卡片"
          data-tour="agent-stack"
          onClick={() => {
            sound.unlock();
            onOpenChange(true);
          }}
        />
      </div>
      <Dialog
        open={mounted}
        onOpenChange={(value) => {
          if (!value) close();
        }}
      >
        <DialogContent
          showOverlay={false}
          onWheel={(event) => {
            if (panel || shown || !open || event.ctrlKey || !event.deltaY)
              return;
            sound.unlock();
            scrollSound.current = true;
            clearTimeout(pickTimer.current);
            clearTimeout(wheelTimer.current);
            const now = performance.now();
            const direction = Math.sign(event.deltaY);
            const state = motion.current;
            // Reverse from the visible position instead of chasing queued travel.
            if (
              wheel.current.direction &&
              direction !== wheel.current.direction &&
              now - wheel.current.lastInput < 180
            ) {
              state.target = state.value;
              state.velocity = 0;
            }
            wheel.current = { direction, lastInput: now };
            const pixels =
              event.deltaY *
              (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? step : 1);
            // Preserve all input, including multiple turns around the deck.
            // The spring follows faster input faster and eases out naturally;
            // native trackpad momentum is not given a second inertia impulse.
            animateTo(state.target + pixels / step);
            wheelTimer.current = setTimeout(() => {
              wheelTimer.current = undefined;
              animateTo(Math.round(motion.current.target));
            }, 140);
          }}
          showCloseButton={false}
          data-slot="agent-deck"
          className="fixed inset-0 top-0 left-0 block h-full w-full max-w-none translate-x-0 translate-y-0 gap-0 rounded-none bg-transparent p-0 ring-0 data-open:animate-none data-closed:animate-none [-webkit-app-region:no-drag] sm:max-w-none"
        >
          <DialogTitle className="sr-only">Agent 卡片</DialogTitle>
          <div
            className="absolute inset-0 bg-black/10 backdrop-blur-md transition-opacity duration-[420ms] motion-reduce:transition-none dark:bg-black/30"
            style={{ opacity: spread ? 1 : 0 }}
            aria-hidden="true"
            data-tour="agent-deck-backdrop"
            onClick={close}
          >
            <span
              data-tour="agent-deck-dismiss"
              className="absolute right-6 bottom-6 size-24"
            />
          </div>
          <div
            className="absolute top-4 right-4 z-30 flex gap-1"
            style={{ opacity: spread ? 1 : 0 }}
          >
            <Button
              variant="secondary"
              size="icon-sm"
              aria-label="刷新全部状态"
              title="刷新全部状态"
              disabled={refreshing}
              onClick={onRefresh}
            >
              <RefreshCw className={refreshing ? "animate-spin" : ""} />
            </Button>
            <Button
              variant="secondary"
              size="icon-sm"
              aria-label="收起"
              data-tour="agent-deck-close"
              onClick={close}
            >
              <X />
            </Button>
          </div>
          {panelVisible && panel && (
            <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none">
              <div className="pointer-events-auto max-h-[85vh] w-[min(600px,calc(100%-3rem))] overflow-y-auto rounded-2xl border bg-popover text-popover-foreground shadow-xl animate-in fade-in zoom-in-95 duration-200 motion-reduce:animate-none">
                {panel}
              </div>
            </div>
          )}
          {shown ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="pointer-events-auto contents">
                <DeckDetail
                  item={shown}
                  load={loadCalls}
                  onBack={() => setDetail(null)}
                />
              </div>
            </div>
          ) : (
            <div
              role="radiogroup"
              aria-label="Agent"
              data-tour="agent-deck"
              className="agent-deck-window pointer-events-none absolute inset-y-0 left-1/2 w-[min(560px,calc(100%-3rem))] -translate-x-1/2"
              data-spread={(spread && !panel) || undefined}
              style={{
                width: Math.min(origin.width, window.innerWidth - 48),
                ["--deck-edge" as string]: `${(n * step) / 2 - 24}px`,
              }}
              onKeyDown={keys}
            >
              <div
                className="agent-deck-edge agent-deck-edge-top"
                aria-hidden="true"
              />
              <div
                className="agent-deck-edge agent-deck-edge-bottom"
                aria-hidden="true"
              />
              {items.map((item, i) => {
                const d = spread && !panel ? offset(i, position) : 0;
                const hidden = Math.abs(d) > n / 2;
                const depth = (i - frontIndex + n) % n;
                const layer = Math.min(depth, visible);
                return (
                  <div
                    key={item.id}
                    className={cn(
                      cardClass,
                      "agent-deck-card absolute inset-x-0 top-1/2",
                      !hidden && !panel && "pointer-events-auto",
                    )}
                    style={{
                      transition:
                        spread && !panel && frame.current !== undefined
                          ? "box-shadow 200ms"
                          : undefined,
                      transform: spread
                        ? transform(d)
                        : `translate(${origin.x}px, calc(-50% + ${origin.y + layer * (6 + 56 * 0.04)}px)) scale(${1 - layer * 0.04})`,
                      opacity: panel
                        ? 0
                        : spread
                          ? 1
                          : depth <= visible
                            ? 1
                            : 0,
                      zIndex: spread ? 10 - Math.abs(d) : n - depth,
                    }}
                    data-tour={item.tour}
                    data-agent={
                      item.tour === "agent-card" ? item.id : undefined
                    }
                    data-status={
                      item.tour === "agent-card" ? item.status : undefined
                    }
                    data-selected={item.selected || undefined}
                    data-center={d === 0 || undefined}
                    aria-hidden={hidden || undefined}
                  >
                    <Button
                      variant="ghost"
                      data-slot="agent-select"
                      role="radio"
                      aria-checked={!!item.selected}
                      aria-disabled={item.status !== "ready"}
                      aria-label={`使用 ${item.title}`}
                      tabIndex={d === 0 ? 0 : -1}
                      className="absolute inset-0 h-auto rounded-2xl p-0 hover:bg-transparent dark:hover:bg-transparent"
                      onFocus={() => {
                        if (open && spread && !panel) move(i);
                      }}
                      onClick={() => pick(i)}
                    />
                    <CardFace
                      item={item}
                      detail={
                        <>
                          {item.extra}
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="pointer-events-auto -mr-1 -mb-1"
                            aria-label={`${item.title} 详情`}
                            onClick={() => {
                              if (onDetail(item.id)) setDetail(item.id);
                            }}
                          >
                            <ChevronRight />
                          </Button>
                        </>
                      }
                    />
                  </div>
                );
              })}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
