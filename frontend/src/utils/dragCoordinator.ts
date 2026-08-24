/**
 * Custom pointer-based drag helpers.
 *
 * Why not HTML5 native Drag-and-Drop (`draggable` + `dataTransfer`)?
 * Wails renders through a different native webview per OS (WebView2 on
 * Windows, WebKitGTK on Linux, WKWebView on macOS), and HTML5 DnD
 * support across those has a long history of inconsistencies -
 * `dataTransfer` payloads and drag image rendering in particular don't
 * behave the same way in an embedded webview as they do in a full
 * browser. The rest of this app's timeline (dragging/trimming a clip)
 * was already built on plain mousedown/mousemove/mouseup tracking
 * rather than native DnD, for the same reason - this module extends
 * that same reliable approach to media-library-to-timeline placement
 * and cross-track clip moves, instead of introducing a second,
 * less-reliable drag mechanism alongside it.
 */

/** Finds the timeline track lane element under a given point, if any (tracks mark themselves with data-track-id/data-track-type - see TimelineTrack.tsx). */
export function findTrackElementAtPoint(x: number, y: number): HTMLElement | null {
  const el = document.elementFromPoint(x, y);
  return (el?.closest("[data-track-id]") as HTMLElement) ?? null;
}

/** A small floating label that follows the cursor for the duration of a drag, giving visual feedback that something is being dragged and what it is. */
export function createDragGhost(label: string) {
  const el = document.createElement("div");
  el.textContent = label;
  Object.assign(el.style, {
    position: "fixed",
    pointerEvents: "none",
    zIndex: "9999",
    padding: "4px 10px",
    borderRadius: "6px",
    fontSize: "11px",
    fontWeight: "500",
    background: "rgba(59, 130, 246, 0.95)",
    color: "white",
    transform: "translate(-50%, -140%)",
    whiteSpace: "nowrap",
    boxShadow: "0 2px 8px rgba(0,0,0,0.35)",
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(el);

  return {
    moveTo(x: number, y: number) {
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
    },
    remove() {
      el.remove();
    },
  };
}
