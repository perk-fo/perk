"use client";

import { useEffect, useRef, type RefObject } from "react";

/**
 * Close a transient popup (a menu or dropdown) the way people expect: on a press anywhere outside `ref`, the element
 * that holds both the trigger and the popup; on Escape, which also hands focus back to the trigger; and when keyboard
 * focus moves outside it.
 *
 * It listens on the document rather than laying a full-screen backdrop under the popup. A `position: fixed` backdrop
 * is sized by the nearest ancestor with a transform or a backdrop-filter, and in the blurred sticky header that is the
 * header itself, so presses on the page below never reached it and the menus stayed open.
 */
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void): void {
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (!open) return;
    const outside = (target: EventTarget | null) =>
      !!ref.current && target instanceof Node && !ref.current.contains(target);
    const onPointerDown = (e: PointerEvent) => {
      if (outside(e.target)) closeRef.current();
    };
    const onFocusIn = (e: FocusEvent) => {
      if (outside(e.target)) closeRef.current();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      closeRef.current();
      ref.current?.querySelector<HTMLElement>("button")?.focus();
    };
    // capture, so a handler that stops propagation inside the page cannot keep the menu open
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [ref, open]);
}
