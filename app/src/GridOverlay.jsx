import { useEffect, useRef } from "react";
import { isGridCell } from "./table.js";

/* Highlights the row and column of the cell the user last clicked. It paints
   into an overlay above the Excalidraw canvases and reads geometry from the
   scene each frame, so scrolling, zooming and resizing all stay in sync
   without the editor telling us about them. */
export default function GridOverlay({ apiRef, canvasRef, activeCell }) {
  const rowRef = useRef(null);
  const colRef = useRef(null);
  const badgeRef = useRef(null);

  useEffect(() => {
    const api = apiRef.current;
    const host = canvasRef.current;
    if (!api || !host || !activeCell) return undefined;

    let frame = 0;
    const paint = () => {
      frame = window.requestAnimationFrame(paint);
      const rowEl = rowRef.current;
      const colEl = colRef.current;
      if (!rowEl || !colEl) return;

      const { grid, r, c } = activeCell;
      const state = api.getAppState();
      const zoom = state.zoom?.value || 1;
      const scrollX = state.scrollX || 0;
      const scrollY = state.scrollY || 0;
      // the transparent table frame shares customData.grid but is not a cell:
      // counting it would stretch the row/column highlight over marker space
      const cells = api.getSceneElements().filter((el) => isGridCell(el, grid));

      const box = (list) => {
        if (!list.length) return null;
        let left = Infinity;
        let top = Infinity;
        let right = -Infinity;
        let bottom = -Infinity;
        for (const el of list) {
          left = Math.min(left, el.x);
          top = Math.min(top, el.y);
          right = Math.max(right, el.x + el.width);
          bottom = Math.max(bottom, el.y + el.height);
        }
        return {
          left: (left + scrollX) * zoom,
          top: (top + scrollY) * zoom,
          width: (right - left) * zoom,
          height: (bottom - top) * zoom,
        };
      };

      const put = (el, boxed) => {
        if (!el) return;
        if (!boxed) {
          el.style.opacity = "0";
          return;
        }
        el.style.opacity = "1";
        el.style.left = `${boxed.left}px`;
        el.style.top = `${boxed.top}px`;
        el.style.width = `${boxed.width}px`;
        el.style.height = `${boxed.height}px`;
      };

      const rowBox = box(cells.filter((el) => el.customData.r === r));
      const colBox = box(cells.filter((el) => el.customData.c === c));
      put(rowEl, rowBox);
      put(colEl, colBox);

      const badge = badgeRef.current;
      if (badge) {
        const anchor = rowBox && colBox ? { left: Math.min(rowBox.left, colBox.left), top: Math.min(rowBox.top, colBox.top) } : null;
        badge.style.opacity = anchor ? "1" : "0";
        if (anchor) {
          badge.style.left = `${anchor.left}px`;
          badge.style.top = `${Math.max(0, anchor.top - 24)}px`;
          badge.textContent = `แถว ${r + 1} · คอลัมน์ ${c + 1}`;
        }
      }
    };

    frame = window.requestAnimationFrame(paint);
    return () => window.cancelAnimationFrame(frame);
  }, [apiRef, canvasRef, activeCell]);

  if (!activeCell) return null;

  const highlight = {
    position: "absolute",
    pointerEvents: "none",
    borderRadius: "6px",
    background: "rgba(105,101,219,0.10)",
    boxShadow: "inset 0 0 0 1.5px rgba(105,101,219,0.55)",
    opacity: "0",
    transition: "opacity 120ms ease",
  };

  return (
    <div
      className="grid-overlay"
      style={{ position: "absolute", inset: "0", pointerEvents: "none", zIndex: 6, overflow: "hidden" }}
      aria-hidden="true"
    >
      <div ref={rowRef} style={highlight} />
      <div ref={colRef} style={highlight} />
      <div
        ref={badgeRef}
        style={{
          position: "absolute",
          pointerEvents: "none",
          padding: "3px 8px",
          borderRadius: "999px",
          background: "rgba(105,101,219,0.92)",
          color: "#fff",
          fontSize: "11px",
          lineHeight: 1.5,
          whiteSpace: "nowrap",
          opacity: "0",
          transition: "opacity 120ms ease",
        }}
      />
    </div>
  );
}
