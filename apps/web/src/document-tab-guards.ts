export type TabCloseWarning = { message: string; blocked?: boolean };
const guards = new Map<string, () => TabCloseWarning | null>();
export function registerTabCloseGuard(
  id: string,
  guard: () => TabCloseWarning | null,
) {
  guards.set(id, guard);
  return () => {
    if (guards.get(id) === guard) guards.delete(id);
  };
}
export function tabCloseWarning(id: string) {
  return guards.get(id)?.() ?? null;
}
