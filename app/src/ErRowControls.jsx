import { useEffect, useRef } from "react";
import { classRowBounds } from "./class.js";

/* Draw.io-style row affordances for an ER class. Plain click selects one row,
   Shift+click adds/removes rows; + / − sit just outside the frame. */

export default function ErRowControls({ apiRef, canvasRef, activeRows, onAdd, onDelete }) {
  const highlightRefs = useRef([]);
  const controlsRef = useRef(null);
  const rows = activeRows || [];

  useEffect(() => {
    if (!rows.length) return undefined;
    let frame = 0;
    const paint = () => {
      frame = window.requestAnimationFrame(paint);
      const api = apiRef.current;
      const host = canvasRef.current;
      const controls = controlsRef.current;
      if (!api || !host || !controls) return;

      const elements = api.getSceneElements();
      const state = api.getAppState();
      const zoom = state.zoom?.value || 1;
      const scrollX = state.scrollX || 0;
      const scrollY = state.scrollY || 0;
      const rect = host.getBoundingClientRect();
      const sx = (value) => rect.left + (value + scrollX) * zoom;
      const sy = (value) => rect.top + (value + scrollY) * zoom;

      const boxes = rows.map((row) =>
        classRowBounds(elements, row.grid, row.section, row.index),
      );
      const grid = rows[0]?.grid;
      const cls = elements.find(
        (el) => el.customData?.grid === grid && el.customData?.class && el.customData?.frame,
      );
      const valid = boxes.map((box, index) => ({ box, el: highlightRefs.current[index] }));
      if (!valid.some(({ box }) => box) || !cls) {
        controls.style.opacity = "0";
        controls.style.pointerEvents = "none";
        for (const { el } of valid) if (el) el.style.opacity = "0";
        return;
      }

      valid.forEach(({ box, el }) => {
        if (!el) return;
        if (!box) {
          el.style.opacity = "0";
          return;
        }
        el.style.opacity = "1";
        el.style.left = `${sx(box.left)}px`;
        el.style.top = `${sy(box.top)}px`;
        el.style.width = `${box.width * zoom}px`;
        el.style.height = `${box.height * zoom}px`;
      });

      const last = [...boxes].reverse().find(Boolean);
      if (!last) return;
      controls.style.opacity = "1";
      controls.style.pointerEvents = "auto";
      controls.style.left = `${sx(cls.x + cls.width) + 14}px`;
      controls.style.top = `${sy(last.centerY)}px`;
    };

    frame = window.requestAnimationFrame(paint);
    return () => window.cancelAnimationFrame(frame);
  }, [apiRef, canvasRef, rows]);

  if (!rows.length) return null;
  const last = rows[rows.length - 1];

  return (
    <div className="er-row-overlay" role="group" aria-label="จัดการ row">
      {rows.map((row, index) => (
        <div
          className="er-row-highlight"
          key={`${row.grid}-${row.section}-${row.index}`}
          ref={(el) => {
            highlightRefs.current[index] = el;
          }}
        />
      ))}
      <div className="er-row-controls" ref={controlsRef}>
        <button
          type="button"
          className="er-row-btn"
          aria-label="เพิ่ม row ใต้แถวที่เลือก"
          title="เพิ่ม row"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onAdd?.(last);
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
            onDelete?.([...rows]);
          }}
        >
          −
        </button>
      </div>
    </div>
  );
}
