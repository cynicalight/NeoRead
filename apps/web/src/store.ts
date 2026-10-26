import { create } from "zustand";
import {
  defaultTheme,
  type Document,
  type ReaderTheme,
  type AIConfig,
  type LibraryMode,
  type LibraryPreferences,
  type NeoReadLinkTarget,
} from "@neoread/core";
import { api } from "@neoread/api";
import { readingSession } from "./reading-session";
import { forgetProgress } from "./progress";
let openRevision = 0;
type ClosedTabGroup = {
  tabs: { id: string; index: number }[];
  activeId: string;
};

function sessionPatch(
  theme: ReaderTheme,
  tabIds: string[],
  active: Document | null,
) {
  const saved = theme.readingSession;
  const activeId = active?.id ?? null;
  return {
    tabIds,
    active,
    theme:
      saved?.activeId === activeId &&
      Array.isArray(saved.documentIds) &&
      saved.documentIds.length === tabIds.length &&
      saved.documentIds.every((id, i) => id === tabIds[i])
        ? theme
        : { ...theme, readingSession: { documentIds: tabIds, activeId } },
  };
}
const tabsEnabled = (theme: ReaderTheme) => theme.documentTabs === true;
/** The tab bar also stays while turning tabs off closes the extra tabs. */
export const documentTabsShown = (state: {
  theme: ReaderTheme;
  tabIds: string[];
  closedTabGroups: ClosedTabGroup[];
}) =>
  tabsEnabled(state.theme)
    ? state.tabIds.length > 0 || state.closedTabGroups.length > 0
    : state.tabIds.length > 1;
export const useReaderStore = create<{
  documents: Document[];
  active: Document | null;
  tabIds: string[];
  visitedTabs: string[];
  sessionReady: boolean;
  restoreSession: () => void;
  openMany: (documents: Document[]) => void;
  closeTab: (id: string) => void;
  /** Move a tab to `index` in the tab order. */
  moveTab: (id: string, index: number) => void;
  closeTabs: (ids: string[]) => void;
  reopenTabs: () => Document | null;
  closedTabGroups: ClosedTabGroup[];
  theme: ReaderTheme;
  aiConfig?: AIConfig;
  aiModelSaving: boolean;
  libraryPreferences: LibraryPreferences;
  trash: Document[];
  setTrash: (trash: Document[]) => void;
  /** A neoread:// target waiting for its document to open. */
  linkTarget: NeoReadLinkTarget | null;
  setLinkTarget: (target: NeoReadLinkTarget | null) => void;
  setLibraryPreferences: (preferences: LibraryPreferences) => void;
  setAIConfig: (config: AIConfig) => void;
  setAIModelSaving: (saving: boolean) => void;
  setDocuments: (documents: Document[]) => void;
  open: (active: Document | null) => void;
  setTheme: (patch: Partial<ReaderTheme>) => void;
}>((set, get) => ({
  documents: [],
  active: null,
  tabIds: [],
  visitedTabs: [],
  sessionReady: false,
  closedTabGroups: [],
  restoreSession: () =>
    set((state) => {
      if (state.sessionReady) return state;
      const session = tabsEnabled(state.theme)
        ? readingSession(state.theme.readingSession, state.documents)
        : { documentIds: [], activeId: null };
      const active =
        state.documents.find((d) => d.id === session.activeId) ?? null;
      return {
        ...sessionPatch(state.theme, session.documentIds, active),
        visitedTabs: active ? [active.id] : [],
        sessionReady: true,
      };
    }),
  openMany: (documents) => {
    ++openRevision;
    set((state) => {
      if (!documents.length) return state;
      const active = documents[0];
      return {
        ...sessionPatch(
          state.theme,
          [...new Set([...state.tabIds, ...documents.map((d) => d.id)])],
          active,
        ),
        visitedTabs: [...new Set([...state.visitedTabs, active.id])],
        sessionReady: true,
      };
    });
  },
  closeTab: (id) => get().closeTabs([id]),
  moveTab: (id, index) =>
    set((state) => {
      const from = state.tabIds.indexOf(id);
      const to = Math.max(0, Math.min(index, state.tabIds.length - 1));
      if (from < 0 || from === to) return state;
      const ids = state.tabIds.filter((tab) => tab !== id);
      ids.splice(to, 0, id);
      return sessionPatch(state.theme, ids, state.active);
    }),
  closeTabs: (requested) =>
    set((state) => {
      const removing = new Set(requested);
      const closed = state.tabIds.flatMap((id, index) =>
        removing.has(id) ? [{ id, index }] : [],
      );
      if (!closed.length) return state;
      const ids = state.tabIds.filter((id) => !removing.has(id));
      const activeRemoved = state.active && removing.has(state.active.id);
      const index = state.tabIds.indexOf(state.active?.id ?? "");
      const neighbor =
        state.tabIds.slice(index + 1).find((id) => !removing.has(id)) ??
        state.tabIds
          .slice(0, index)
          .reverse()
          .find((id) => !removing.has(id));
      const active = activeRemoved
        ? (state.documents.find((doc) => doc.id === neighbor) ?? null)
        : state.active;
      return {
        ...sessionPatch(state.theme, ids, active),
        visitedTabs: [
          ...new Set([
            ...state.visitedTabs.filter((id) => !removing.has(id)),
            ...(active ? [active.id] : []),
          ]),
        ],
        closedTabGroups: [
          ...state.closedTabGroups,
          {
            tabs: closed,
            activeId: activeRemoved
              ? state.active!.id
              : closed[closed.length - 1].id,
          },
        ].slice(-20),
      };
    }),
  reopenTabs: () => {
    let opened: Document | null = null;
    set((state) => {
      const groups = [...state.closedTabGroups];
      while (groups.length) {
        const group = groups.pop()!;
        const restored = group.tabs.filter(
          (tab) =>
            !state.tabIds.includes(tab.id) &&
            state.documents.some((doc) => doc.id === tab.id),
        );
        if (!restored.length) continue;
        const ids = [...state.tabIds];
        for (const tab of restored)
          ids.splice(Math.min(tab.index, ids.length), 0, tab.id);
        const selected = restored.some((tab) => tab.id === group.activeId)
          ? group.activeId
          : restored[restored.length - 1].id;
        opened = state.documents.find((doc) => doc.id === selected)!;
        return {
          ...sessionPatch(state.theme, ids, opened),
          visitedTabs: [...new Set([...state.visitedTabs, selected])],
          closedTabGroups: groups,
        };
      }
      return { closedTabGroups: groups };
    });
    return opened;
  },
  theme: defaultTheme,
  aiModelSaving: false,
  libraryPreferences: {},
  trash: [],
  setTrash: (trash) => set({ trash }),
  linkTarget: null,
  setLinkTarget: (linkTarget) => set({ linkTarget }),
  setLibraryPreferences: (libraryPreferences) => set({ libraryPreferences }),
  setAIConfig: (aiConfig) => set({ aiConfig }),
  setAIModelSaving: (aiModelSaving) => set({ aiModelSaving }),
  setDocuments: (documents) =>
    set((state) => {
      if (!state.sessionReady)
        return {
          documents,
          active: documents.find((d) => d.id === state.active?.id) ?? null,
        };
      const available = new Set(documents.map((d) => d.id));
      const ids = state.tabIds.filter((id) => available.has(id));
      const activeId =
        state.active &&
        (available.has(state.active.id)
          ? state.active.id
          : ids[
              Math.min(state.tabIds.indexOf(state.active.id), ids.length - 1)
            ]);
      const active = documents.find((d) => d.id === activeId) ?? null;
      return {
        documents,
        closedTabGroups: state.closedTabGroups.flatMap((group) => {
          const tabs = group.tabs.filter((tab) => available.has(tab.id));
          return tabs.length ? [{ ...group, tabs }] : [];
        }),
        ...sessionPatch(state.theme, ids, active),
        visitedTabs: [
          ...new Set([
            ...state.visitedTabs.filter((id) => available.has(id)),
            ...(active ? [active.id] : []),
          ]),
        ],
      };
    }),
  open: (active) => {
    ++openRevision;
    set((state) => {
      // Without tabs, a document replaces the current one and the library
      // releases it, as before tabs existed.
      if (!tabsEnabled(state.theme)) {
        const ids = active ? [active.id] : [];
        return {
          ...sessionPatch(state.theme, ids, active),
          visitedTabs: ids,
          sessionReady: true,
        };
      }
      return {
        ...sessionPatch(
          state.theme,
          active ? [...new Set([...state.tabIds, active.id])] : state.tabIds,
          active,
        ),
        visitedTabs: active
          ? [...new Set([...state.visitedTabs, active.id])]
          : state.visitedTabs,
        sessionReady: true,
      };
    });
  },
  setTheme: (patch) =>
    set((state) => ({ theme: { ...state.theme, ...patch } })),
}));
let libraryRevision = 0;
export function forgetLibraryDocuments(ids: string[]) {
  ++libraryRevision;
  forgetProgress(ids);
  const state = useReaderStore.getState();
  state.setDocuments(state.documents.filter((d) => !ids.includes(d.id)));
}
export async function refreshLibrary() {
  const revision = ++libraryRevision;
  const documents = await api.documents();
  if (revision === libraryRevision)
    useReaderStore.getState().setDocuments(documents);
}
export async function refreshAIConfig() {
  const before = useReaderStore.getState().aiConfig;
  const config = await api.aiConfig();
  // A concurrent settings save owns its newer snapshot.
  if (useReaderStore.getState().aiConfig === before)
    useReaderStore.getState().setAIConfig(config);
}
export const primaryLibraryMode = (
  preferences: LibraryPreferences,
): LibraryMode => (preferences.primaryMode === "books" ? "books" : "papers");
export const libraryMode = (preferences: LibraryPreferences): LibraryMode =>
  preferences.mode === "books" || preferences.mode === "papers"
    ? preferences.mode
    : primaryLibraryMode(preferences);
export async function loadLibraryPreferences() {
  const preferences = await api.libraryPreferences();
  useReaderStore.getState().setLibraryPreferences({
    ...preferences,
    mode: primaryLibraryMode(preferences),
  });
}
let preferenceWrite = Promise.resolve();
/** Apply locally at once; writes are serialized so the last change wins. */
export function updateLibraryPreferences(patch: Partial<LibraryPreferences>) {
  const state = useReaderStore.getState();
  const next = { ...state.libraryPreferences, ...patch };
  state.setLibraryPreferences(next);
  preferenceWrite = preferenceWrite
    .catch(() => {})
    .then(() => api.saveLibraryPreferences(next))
    .then(() => {});
  return preferenceWrite;
}
let trashRevision = 0;
/** The trash of the current library; older responses never overwrite newer ones. */
export async function refreshTrash() {
  const revision = ++trashRevision;
  const state = useReaderStore.getState();
  const trash = await api.trash(libraryMode(state.libraryPreferences));
  if (revision === trashRevision) useReaderStore.getState().setTrash(trash);
}
/** Check the persisted parsing stage before entering a paper reader. */
export async function openLibraryDocument(
  doc: Document,
  target?: NeoReadLinkTarget,
) {
  const revision = ++openRevision;
  if (doc.library === "papers") {
    const jobs = await api.processing();
    if (revision !== openRevision) return false;
    const job = jobs.find((job) => job.documentId === doc.id);
    if (!job || job.phase === "learning" || job.incomplete)
      throw new Error("论文飞速解析中，请稍等");
  }
  const state = useReaderStore.getState();
  if (target && libraryMode(state.libraryPreferences) !== doc.library)
    void updateLibraryPreferences({ mode: doc.library }).catch(() => {});
  state.setLinkTarget(target ?? null);
  state.open(doc);
  return true;
}

/** Open the document a neoread:// link points to, in its own library. */
export async function openLinkTarget(target: NeoReadLinkTarget) {
  let doc = useReaderStore.getState().documents.find((d) => d.id === target.id);
  if (!doc) {
    await refreshLibrary();
    doc = useReaderStore.getState().documents.find((d) => d.id === target.id);
  }
  if (!doc) return false;
  await openLibraryDocument(doc, target);
  return true;
}

// Cache only safe reproducibility settings in the shell, available after sidecar failure.
useReaderStore.subscribe((state, previous) => {
  if (
    state.theme === previous.theme &&
    state.aiConfig === previous.aiConfig &&
    state.libraryPreferences === previous.libraryPreferences
  )
    return;
  if (typeof window !== "undefined")
    window.neoreadDesktop?.diagnosticSettings?.({
      ...state.theme,
      mode: state.libraryPreferences.mode,
      primaryMode: state.libraryPreferences.primaryMode,
      provider: state.aiConfig?.primary,
      chatModel: state.aiConfig?.models[state.aiConfig.primary],
      translationModel:
        state.aiConfig?.translationModels?.[state.aiConfig.primary],
    });
});
