export type TabCloseWarning = { message: string; blocked?: boolean };
type Guard = () => TabCloseWarning | null;
// Several parts of a reader may hold unsaved state for the same document.
const guards = new Map<string, Set<Guard>>();
export function registerTabCloseGuard(id: string, guard: Guard) {
  const set = guards.get(id) ?? new Set<Guard>();
  guards.set(id, set.add(guard));
  return () => {
    set.delete(guard);
    if (!set.size && guards.get(id) === set) guards.delete(id);
  };
}
export function tabCloseWarning(id: string) {
  const warnings = [...(guards.get(id) ?? [])].flatMap((guard) => guard() ?? []);
  return warnings.find((warning) => warning.blocked) ?? warnings[0] ?? null;
}
