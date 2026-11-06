import { useEffect, useMemo, useState } from "react";
import { api, type ChatSkill } from "@neoread/api";
import { Check, Plus } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@neoread/ui/components/popover";
import { Button } from "@neoread/ui/components/button";
import { Input } from "@neoread/ui/components/input";

/**
 * Chat skill picker. Selection is per question and capped on the server too;
 * this component only narrows the list and keeps the trigger honest.
 */
export function SkillPicker({
  selected,
  onChange,
  disabled = false,
}: {
  selected: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [skills, setSkills] = useState<ChatSkill[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void api
      .chatSkills(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setSkills(result.skills);
      })
      .catch((reason: Error) => {
        if (!controller.signal.aborted) setError(reason.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, retry]);
  const filtered = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    if (!keyword) return skills;
    return skills.filter(
      (skill) =>
        skill.name.toLocaleLowerCase().includes(keyword) ||
        skill.description.toLocaleLowerCase().includes(keyword),
    );
  }, [skills, query]);
  const count = selected.length;
  const toggle = (name: string) => {
    if (selected.includes(name)) {
      onChange(selected.filter((item) => item !== name));
      return;
    }
    if (count >= 3) return;
    onChange([...selected, name]);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button type="button" size="icon-xs" variant="ghost" />}
        className="skill-trigger"
        aria-label="选择技能"
        title="选择技能"
        disabled={disabled}
      >
        <Plus aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent align="start" className="skill-panel">
        <PopoverTitle className="skill-panel-title">技能</PopoverTitle>
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索技能"
          aria-label="搜索技能"
          className="skill-search"
        />
        <div className="skill-list">
          {loading && <p className="skill-status">正在加载技能…</p>}
          {!loading && error && (
            <div className="skill-status">
              <span>{error}</span>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => setRetry((value) => value + 1)}
              >
                重试
              </Button>
            </div>
          )}
          {!loading && !error && filtered.length === 0 && (
            <p className="skill-status">
              {skills.length === 0
                ? "还没有可用技能。"
                : "没有匹配的技能。"}
            </p>
          )}
          {!loading &&
            !error &&
            filtered.map((skill) => {
              const checked = selected.includes(skill.name);
              return (
                <button
                  key={skill.name}
                  type="button"
                  className="skill-row"
                  data-checked={checked || undefined}
                  aria-pressed={checked}
                  disabled={!checked && count >= 3}
                  onClick={() => toggle(skill.name)}
                >
                  <span className="skill-check">
                    {checked && <Check size={12} aria-hidden="true" />}
                  </span>
                  <span className="skill-row-text">
                    <span className="skill-name">{skill.name}</span>
                    {skill.description && (
                      <span className="skill-description">
                        {skill.description}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
        </div>
        {count >= 3 && <p className="skill-hint">每次最多选择 3 个技能</p>}
      </PopoverContent>
    </Popover>
  );
}
