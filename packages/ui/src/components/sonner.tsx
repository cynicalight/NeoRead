"use client";

import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

/**
 * shadcn Sonner toaster. Rendering into `document.body` keeps notifications
 * above this app's isolated shell, portalled dialogs and guided tour.
 */
function Toaster({ style, ...props }: ToasterProps) {
  return createPortal(
    <Sonner
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
          zIndex: 2147483647,
          ...style,
        } as CSSProperties
      }
      {...props}
    />,
    document.body,
  );
}

export { Toaster };
