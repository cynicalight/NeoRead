import {
  memo,
  useLayoutEffect,
  useState,
  type ComponentProps,
  type RefObject,
} from "react";
import type { DocumentLocation } from "@neoread/core";
import { NavigationTree } from "./NavigationTree";

/** Scroll position updates the outline without rendering the PDF, translation,
 * selection overlays and conversation again on every scroll frame. */
export const LiveNavigationTree = memo(function LiveNavigationTree({
  location,
  changed,
  ...props
}: Omit<ComponentProps<typeof NavigationTree>, "location"> & {
  location: RefObject<DocumentLocation | undefined>;
  changed: RefObject<((next: DocumentLocation) => void) | undefined>;
}) {
  const [current, setCurrent] = useState(() => location.current);
  useLayoutEffect(() => {
    changed.current = setCurrent;
    return () => {
      changed.current = undefined;
    };
  }, [changed]);
  return <NavigationTree {...props} location={current} />;
});
