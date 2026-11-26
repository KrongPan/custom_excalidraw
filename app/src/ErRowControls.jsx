import { useEffect, useRef } from "react";
import { classRowBounds } from "./class.js";

/* Draw.io-style row affordances for an ER class: the selected fields/methods
   row gets a highlight and a small + / − pair just outside the frame. */

export default function ErRowControls({ apiRef, canvasRef, activeRow, onAdd, onDelete }) {
  const rootRef = useRef(null);
  const highlightRef = useRef(null);
  const controlsRef = useRef(null);

  useEffect(() => {
    if (!activeRow) return undefined;
    let frame = 0;
    const paint = () => {
      frame = window.requestAnimationFrame(paint);
      const api = apiRef.current;
      const host = canvasRef.current;
      const controls = controlsRef.current;
      const highlight = highlightRef.current;
      if (!api || !host || !controls || !highlight) return;

      const elements = api.getSceneElements();
      const box = classRowBounds(elements, activeRow.grid, activeRow.section, activeRow.index);
      const cls = elements.find(
        (el) => el.customData?.grid === activeRow.grid && el.customData?.class && el.customData?.frame,
      );
      if (!box || !cls) {
        controls.style.opacity = "0";
        controls.style.pointerEvents = "none";
        highlight.style.opacity = "0";
        return;
      }

      const state = api.getAppState();
      const zoom = state.zoom?.value || 1;
      const scrollX = state.scrollX || 0;
      const scrollY = state.scrollY || 0;
      const rect = host.getBoundingClientRect();
      const sx = (value) => rect.left + (value + scrollX) * zoom;
      const sy = (value) => rect.top + (value + scrollY) * zoom;

      highlight.style.opacity = "1";
      highlight.style.left = `${sx(box.left)}px`;
      highlight.style.top = `${sy(box.top)}px`;
      highlight.style.width = `${box.width * zoom}px`;
      highlight.style.height = `${box.height * zoom}px`;

      controls.style.opacity = "1";
      controls.style.pointerEvents = "auto";
      controls.style.left = `${sx(cls.x + cls.width) + 14}px`;
      controls.style.top = `${sy(box.centerY)}px`;
    };

    frame = window.requestAnimationFrame(paint);
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [apiRef, canvasRef, activeRow]);

  if (!activeRow) return null;

  return (
    <div className="er-row-overlay" ref={rootRef} role="group" aria-label="จัดการ row">
      <div className="er-row-highlight" ref={highlightRef} />
      <div className="er-row-controls" ref={controlsRef}>
        <button
          type="button"
          className="er-row-btn"
          aria-label="เพิ่ม row ใต้แถวที่เลือก"
          title="เพิ่ม row"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onAdd?.(activeRow);
          }}
        >
          +
        </button>
        <button
          type="button"
          className="er-row-btn er-row-del"
          aria-label="ลบ row ที่เลือก"
          title="ลบ row"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onDelete?.(activeRow);
          }}
        >
          −
        </button>
      </div>
    </div>
  );
}
