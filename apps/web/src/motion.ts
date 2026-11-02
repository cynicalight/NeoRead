import { useReaderStore } from "./store";

/** App preference only: system animation settings never change this value. */
export const reducedMotion = () =>
  useReaderStore.getState().theme.reducedMotion === true;

export const useReducedMotion = () =>
  useReaderStore((state) => state.theme.reducedMotion === true);

export function subscribeMotion(listener: () => void) {
  return useReaderStore.subscribe((state, previous) => {
    if (
      (state.theme.reducedMotion === true) !==
      (previous.theme.reducedMotion === true)
    )
      listener();
  });
}

/** Also installed in EPUB documents so their injected styles use the same setting. */
export function installMotionPreference(doc: Document) {
  const update = () => {
    doc.documentElement.dataset.reducedMotion = String(reducedMotion());
  };
  update();
  const unsubscribe = subscribeMotion(update);
  return () => {
    unsubscribe();
    delete doc.documentElement.dataset.reducedMotion;
  };
}
