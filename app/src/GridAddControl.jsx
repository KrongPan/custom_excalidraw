import { useEffect, useRef, useState } from "react";
import { tableBounds } from "./table.js";

/* One `+` handle that rides the bottom-right corner of whichever table the
   pointer is over. It grows that table in place — a row or a column — and never
   spawns a second one. Like GridOverlay it paints into an overlay above the
   Excalidraw canvases and reads scene geometry every frame, so panning/zooming
   keeps the button glued to the table without a React render per frame: only
   entering or leaving a table flips state, every other frame writes styles
   straight to the DOM. */

/** How far outside a grid the pointer may stray before the button leaves. */
const HIT_PAD = 30;
/** The handle sits beside the corner, not on its border (screen px). */
const HANDLE_GAP = 14;
/** Mousedown inside Excalidraw chrome is not a grid hover. */
const IGNORE = ".grid-add, .relation-panel, .panel, .Island, .App-toolbar, .App-menu";

/**
 * Topmost grid under one scene point. Both plain tables and ER classes hit:
 * a class is a grid that only offers its field rows, a table offers both axes.
 * The box comes from the grid's own cells, because a table only grows a frame
 * element once a relation needs one.
 */
function gridAt(scene, x, y, pad = HIT_PAD) {
  const grids = new Map();
  for (const el of scene) {
    const grid = el.customData?.grid;
    if (!grid || el.isDeleted) continue;
    if (!grids.has(grid)) grids.set(grid, { grid, kind: "table" });
    if (el.customData?.class === true) grids.get(grid).kind = "class";
  }
  let hit = null;
  for (const info of grids.values()) {
    const bounds = tableBounds(scene, info.grid);
    if (!bounds) continue;
    const box = {
      left: bounds.left,
      top: bounds.top,
      right: bounds.left + bounds.width,
      bottom: bounds.top + bounds.height,
    };
    if (x >= box.left - pad && x <= box.right + pad && y >= box.top - pad && y <= box.bottom + pad) {
      hit = { grid: info.grid, kind: info.kind, box };
    }
  }
  return hit;
}

export default function GridAddControl({ apiRef, canvasRef, onGrow }) {
  const rootRef = useRef(null);
  const pointerRef = useRef(null);
  const hoveredRef = useRef(null);
  const openRef = useRef(false);
  const [visible, setVisible] = useState(false);
  const [kind, setKind] = useState("table");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    const host = canvasRef.current;
    if (!host) return undefined;

    // The move listener sits on the window, not on the canvas: the handle is
    // painted beside the table, outside the canvas box, so a canvas-only
    // listener fires pointerleave the moment the pointer reaches for it and the
    // button would vanish before it could be clicked.
    const onMove = (event) => {
      if (event.target instanceof Element) {
        // our own handle and menu keep the table they belong to
        if (event.target.closest(".grid-add")) return;
        if (event.target.closest(IGNORE)) {
          if (!openRef.current) pointerRef.current = null;
          return;
        }
      }
      pointerRef.current = { clientX: event.clientX, clientY: event.clientY };
      if (openRef.current) setOpen(false);
    };
    const onDown = (event) => {
      if (event.target instanceof Element && event.target.closest(".grid-add")) return;
      if (openRef.current) setOpen(false);
    };
    const onKey = (event) => {
      if (event.key === "Escape" && openRef.current) setOpen(false);
    };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);

    let frame = 0;
    const paint = () => {
      frame = window.requestAnimationFrame(paint);
      const api = apiRef.current;
      const el = rootRef.current;
      if (!api || !el) return;
      if (!openRef.current) {
        const pointer = pointerRef.current;
        const state = api.getAppState();
        const zoom = state.zoom?.value || 1;
        const scrollX = state.scrollX || 0;
        const scrollY = state.scrollY || 0;
        let hit = null;
        if (pointer) {
          const rect = host.getBoundingClientRect();
          const sceneX = (pointer.clientX - rect.left) / zoom - scrollX;
          const sceneY = (pointer.clientY - rect.top) / zoom - scrollY;
          // the handle is a fixed 24 CSS px: pad in scene units so the outer
          // half of it still counts at low zoom
          hit = gridAt(api.getSceneElements(), sceneX, sceneY, HIT_PAD / zoom);
        }
        const prevGrid = hoveredRef.current ? hoveredRef.current.grid : null;
        const nextGrid = hit ? hit.grid : null;
        if (nextGrid !== prevGrid) {
          hoveredRef.current = hit;
          setVisible(Boolean(hit));
          if (hit) setKind(hit.kind);
        } else if (hit) {
          hoveredRef.current = hit;
        }
        if (!hit) return;
      }

      const target = hoveredRef.current;
      if (!target) return;
      const state = api.getAppState();
      const zoom = state.zoom?.value || 1;
      const scrollX = state.scrollX || 0;
      const scrollY = state.scrollY || 0;
      const [left, top] = [
        (target.box.right + scrollX) * zoom + HANDLE_GAP,
        (target.box.bottom + scrollY) * zoom + HANDLE_GAP,
      ];
      el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    };

    frame = window.requestAnimationFrame(paint);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [apiRef, canvasRef]);

  const grow = (axis) => {
    const target = hoveredRef.current;
    setOpen(false);
    hoveredRef.current = null;
    pointerRef.current = null;
    setVisible(false);
    if (target && onGrow) onGrow(target.grid, axis, target.kind);
  };

  const isClass = kind === "class";

  return (
    <div
      className={`grid-add${visible || open ? " visible" : ""}${open ? " open" : ""}`}
      ref={rootRef}
      aria-hidden={!(visible || open)}
    >
      <button
        type="button"
        className="grid-add-btn"
        aria-label="เพิ่มแถวหรือคอลัมน์ในตารางนี้"
        aria-haspopup="menu"
        aria-expanded={open}
        title="เพิ่มแถวหรือคอลัมน์"
        tabIndex={visible ? 0 : -1}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
      {open ? (
        <div className="grid-add-menu" role="menu" aria-label="เพิ่มในตาราง">
          <button type="button" role="menuitem" className="grid-add-row" onClick={() => grow("row")}>
            + แถว
          </button>
          {isClass ? null : (
            <button type="button" role="menuitem" className="grid-add-row" onClick={() => grow("col")}>
              + คอลัมน์
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
