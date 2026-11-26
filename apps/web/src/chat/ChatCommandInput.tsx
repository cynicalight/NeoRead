import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { ChevronRight, X } from "lucide-react";
import { api, type SkillDraft, type SkillSummary } from "@neoread/api";
import { Button } from "@neoread/ui/components/button";
import { Popover } from "@neoread/ui/components/popover";
import { PopoverListbox } from "@neoread/ui/components/popover-listbox";
import { Textarea } from "@neoread/ui/components/textarea";
import { toast } from "sonner";
import { CreateSkillDialog } from "./CreateSkillDialog";
import type { CustomPrompt } from "./custom-prompts";
import { useCustomPrompts } from "./custom-prompts";

const commands = [
  { name: "new", description: "新建会话" },
  { name: "exit", description: "收起面板" },
  { name: "prompt", description: "插入常用 prompt" },
  { name: "create-skill", description: "创建技能" },
] as const;
const promptPrefix = "/prompt ";
const slashQuery = /^\/[^\s/]*$/;
const createSkillRequest = /^\/create-skill\s([\s\S]*)$/i;

type CommandOption =
  | { kind: "command"; command: (typeof commands)[number] }
  | { kind: "skill"; skill: SkillSummary }
  | { kind: "prompt"; prompt: CustomPrompt };

export function ChatCommandInput({
  inputRef,
  documentId,
  sessionId,
  value,
  onChange,
  skill,
  onSkillChange,
  onNew,
  onExit,
  onSend,
}: {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  documentId: string;
  sessionId?: string;
  value: string;
  onChange: (value: string) => void;
  skill?: string;
  onSkillChange: (name: string | undefined) => void;
  onNew: () => void;
  onExit: () => void;
  onSend: () => void;
}) {
  const listId = useId();
  const [mode, setMode] = useState<"commands" | "prompts" | null>(null);
  const [active, setActive] = useState(0);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [skillDraft, setSkillDraft] = useState<SkillDraft>();
  const [drafting, setDrafting] = useState(false);
  const draftRequest = useRef<AbortController>(null);
  const { prompts, loading, error } = useCustomPrompts();
  const createRequest = createSkillRequest.exec(value)?.[1];
  const commandMode =
    mode === "commands" && (slashQuery.test(value) || createRequest !== undefined);
  const promptMode = mode === "prompts" && value.startsWith(promptPrefix);
  useEffect(() => () => draftRequest.current?.abort(), []);

  useEffect(() => {
    if (!commandMode) return;
    const controller = new AbortController();
    void api.skills(controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) setSkills(result);
      },
      () => {}, // Built-in commands are still available if skill discovery fails.
    );
    return () => controller.abort();
  }, [commandMode]);

  const query = promptMode
    ? value.slice(promptPrefix.length).toLowerCase()
    : commandMode
      ? createRequest !== undefined
        ? "create-skill"
        : value.slice(1).toLowerCase()
      : "";
  const options: CommandOption[] = [];
  if (promptMode) {
    for (const prompt of prompts) {
      if (prompt.description.toLowerCase().includes(query))
        options.push({ kind: "prompt", prompt });
    }
  } else if (commandMode) {
    for (const command of commands) {
      if (command.name.startsWith(query)) options.push({ kind: "command", command });
    }
    if (createRequest === undefined) {
      for (const skill of skills) {
        if (skill.name.toLowerCase().startsWith(query))
          options.push({ kind: "skill", skill });
      }
    }
  }
  const open = promptMode || options.length > 0;
  const selected = Math.min(active, options.length - 1);
  const optionId = (index: number) => `${listId}-${index}`;
  const close = () => setMode(null);
  const createSkill = async () => {
    if (draftRequest.current) return;
    const request = createRequest?.trim();
    if (!request) {
      onChange("");
      setSkillDraft({ name: "", description: "", body: "" });
      return;
    }
    const controller = new AbortController();
    draftRequest.current = controller;
    setDrafting(true);
    const notification = toast.loading("正在起草技能…");
    try {
      const draft = await api.draftSkill(
        { documentId, sessionId, request },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (inputRef.current?.value === value) onChange("");
      close();
      setSkillDraft(draft);
    } catch (error) {
      if (!controller.signal.aborted) {
        toast.error(error instanceof Error ? error.message : "无法起草技能。");
        if (inputRef.current?.value === value) setMode("commands");
      }
    } finally {
      toast.dismiss(notification);
      draftRequest.current = null;
      if (!controller.signal.aborted) setDrafting(false);
    }
  };
  const choose = (option: CommandOption) => {
    if (option.kind === "command" && option.command.name === "prompt") {
      onChange(promptPrefix);
      setMode("prompts");
      setActive(0);
      return;
    }
    close();
    if (option.kind === "prompt") {
      onChange(option.prompt.prompt);
      return;
    }
    if (option.kind === "command" && option.command.name === "create-skill") {
      void createSkill();
      return;
    }
    onChange("");
    if (option.kind === "skill") onSkillChange(option.skill.name);
    else if (option.command.name === "new") onNew();
    else onExit();
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      {skill && (
        <div className="quote-chips">
          <div>
            <span>/{skill}</span>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`移除技能 ${skill}`}
              onClick={() => {
                onSkillChange(undefined);
                inputRef.current?.focus();
              }}
            >
              <X />
            </Button>
          </div>
        </div>
      )}
      <div
        role={mode ? "combobox" : undefined}
        aria-label={mode ? "命令选择" : undefined}
        aria-expanded={mode ? open : undefined}
        aria-controls={open ? listId : undefined}
      >
        <Textarea
          ref={inputRef}
          aria-label="向 AI 提问"
          placeholder="问一个问题，或引用选中的文字…"
          aria-autocomplete={mode ? "list" : undefined}
          aria-haspopup={open ? "listbox" : undefined}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={selected >= 0 ? optionId(selected) : undefined}
          value={value}
          aria-busy={drafting || undefined}
          onBlur={close}
          onChange={(event) => {
            const next = event.currentTarget.value;
            onChange(next);
            setActive(0);
            if (promptMode && next.startsWith(promptPrefix) && !next.includes("\n"))
              return;
            const isCommand = slashQuery.test(next) || createSkillRequest.test(next);
            setMode(isCommand ? "commands" : null);
          }}
          onKeyDown={(event) => {
            const { key, shiftKey, altKey } = event;
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
              if (mode && key === "Escape") event.stopPropagation();
              return;
            }
            const enter = key === "Enter" && !shiftKey && !altKey;
            if (drafting && enter) {
              event.preventDefault();
              return;
            }
            if (key === "Escape" && mode) {
              event.preventDefault();
              event.stopPropagation();
              close();
              return;
            }
            if (selected >= 0 && (key === "ArrowDown" || key === "ArrowUp")) {
              event.preventDefault();
              event.stopPropagation();
              const step = key === "ArrowDown" ? 1 : -1;
              const index = (selected + step + options.length) % options.length;
              setActive(index);
              document.getElementById(optionId(index))?.scrollIntoView?.({
                block: "nearest",
              });
              return;
            }
            if (selected >= 0 && (enter || (key === "Tab" && !shiftKey))) {
              event.preventDefault();
              event.stopPropagation();
              if (!event.repeat) choose(options[selected]);
              return;
            }
            if (enter) {
              event.preventDefault();
              if (!event.repeat) {
                close();
                onSend();
              }
            }
          }}
        />
      </div>
      <PopoverListbox
        id={listId}
        anchor={inputRef}
        side="top"
        align="start"
        aria-label={promptMode ? "常用 prompt" : "聊天命令"}
        onMouseDown={(event) => event.preventDefault()}
      >
        {options.map((option, index) => {
          const item =
            option.kind === "command"
              ? option.command
              : option.kind === "skill"
                ? option.skill
                : option.prompt;
          const name = "name" in item ? item.name : undefined;
          return (
            <div
              id={optionId(index)}
              key={`${option.kind}:${"id" in item ? item.id : item.name}`}
              role="option"
              aria-selected={selected === index}
              className="flex min-h-7 cursor-default items-center gap-2 rounded-md px-2 py-1 text-xs aria-selected:bg-accent aria-selected:text-accent-foreground"
              onPointerMove={(event) => {
                if (event.pointerType === "mouse") setActive(index);
              }}
              onClick={() => choose(option)}
            >
              {name && (
                <span className="max-w-1/2 truncate font-medium" title={`/${name}`}>
                  /{name}
                </span>
              )}
              <span
                className={
                  name
                    ? "min-w-0 flex-1 truncate text-muted-foreground"
                    : "min-w-0 flex-1 truncate"
                }
                title={item.description}
              >
                {item.description}
              </span>
              {option.kind === "command" && option.command.name === "prompt" && (
                <ChevronRight className="size-3 shrink-0" aria-hidden="true" />
              )}
            </div>
          );
        })}
        {!options.length && promptMode && (
          <div
            role="option"
            aria-disabled="true"
            className="px-2 py-1 text-xs text-muted-foreground"
          >
            {loading
              ? "正在读取…"
              : error || (query ? "没有匹配的 prompt" : "还没有常用 prompt")}
          </div>
        )}
      </PopoverListbox>
      {skillDraft && (
        <CreateSkillDialog
          draft={skillDraft}
          returnFocus={inputRef}
          onClose={() => setSkillDraft(undefined)}
          onSaved={(saved) => {
            setSkills((current) => [
              ...current.filter((skill) => skill.name !== saved.name),
              saved,
            ]);
            setSkillDraft(undefined);
          }}
        />
      )}
    </Popover>
  );
}
