import { useEffect, useRef, useState } from "react";
import { tableBounds } from "./table.js";

/* Two growth handles that ride whichever table the pointer is over: one on the
   bottom edge that adds a row, one on the right edge that adds a column. The
   table grows in place and never spawns a second one. Each button sits on the
   axis it grows along, so the direction is obvious without a menu.

   Like GridOverlay it paints into an overlay above the Excalidraw canvases and
   reads scene geometry every frame, so panning/zooming keeps the buttons glued
   to the table without a React render per frame: only entering or leaving a
   table flips state, every other frame writes styles straight to the DOM. */

/** How far outside a grid the pointer may stray before the buttons leave. */
const HIT_PAD = 30;
/** The handles sit beside the edge, not on its border (screen px). */
const HANDLE_GAP = 10;
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
      width: bounds.width,
      height: bounds.height,
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
  const rowRef = useRef(null);
  const colRef = useRef(null);
  const pointerRef = useRef(null);
  const hoveredRef = useRef(null);
  const [visible, setVisible] = useState(false);
  const [kind, setKind] = useState("table");

  useEffect(() => {
    const host = canvasRef.current;
    if (!host) return undefined;

    // The move listener sits on the window, not on the canvas: the buttons are
    // painted beside the table, outside the canvas box, so a canvas-only
    // listener fires pointerleave the moment the pointer reaches for them and
    // they would vanish before they could be clicked. Moves that happen on our
    // own buttons are ignored rather than recorded, which keeps the last
    // in-canvas position (and therefore the hovered table) alive until the
    // pointer leaves for somewhere that is neither.
    const onMove = (event) => {
      if (event.target instanceof Element) {
        if (event.target.closest(".grid-add")) return;
        if (event.target.closest(IGNORE)) {
          pointerRef.current = null;
          return;
        }
      }
      pointerRef.current = { clientX: event.clientX, clientY: event.clientY };
    };
    window.addEventListener("pointermove", onMove, true);

    let frame = 0;
    const paint = () => {
      frame = window.requestAnimationFrame(paint);
      const api = apiRef.current;
      const el = rootRef.current;
      if (!api || !el) return;

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
        // the handles are fixed CSS px: pad in scene units so the outer half of
        // them still counts at low zoom
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

      const { box } = hit;
      const rowX = (box.left + box.width / 2 + scrollX) * zoom;
      const rowY = (box.bottom + scrollY) * zoom + HANDLE_GAP;
      const row = rowRef.current;
      if (row) {
        row.style.transform = `translate(${Math.round(rowX - row.offsetWidth / 2)}px, ${Math.round(rowY)}px)`;
      }
      const col = colRef.current;
      if (col) {
        const colX = (box.right + scrollX) * zoom + HANDLE_GAP;
        const colY = (box.top + box.height / 2 + scrollY) * zoom;
        col.style.transform = `translate(${Math.round(colX)}px, ${Math.round(colY - col.offsetHeight / 2)}px)`;
      }
    };

    frame = window.requestAnimationFrame(paint);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove, true);
    };
  }, [apiRef, canvasRef]);

  const grow = (axis) => {
    const target = hoveredRef.current;
    hoveredRef.current = null;
    pointerRef.current = null;
    setVisible(false);
    if (target && onGrow) onGrow(target.grid, axis, target.kind);
  };

  const isClass = kind === "class";

  return (
    <div className={`grid-add${visible ? " visible" : ""}`} ref={rootRef} aria-hidden={!visible}>
      <button
        ref={rowRef}
        type="button"
        className="grid-add-btn grid-add-row"
        aria-label="เพิ่มแถว"
        title="เพิ่มแถว"
        tabIndex={visible ? 0 : -1}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          grow("row");
        }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true" focusable="false">
          <path d="M12 5v14M5 12h14" />
        </svg>
        แถว
      </button>
      {isClass ? null : (
        <button
          ref={colRef}
          type="button"
          className="grid-add-btn grid-add-col"
          aria-label="เพิ่มคอลัมน์"
          title="เพิ่มคอลัมน์"
          tabIndex={visible ? 0 : -1}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            grow("col");
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true" focusable="false">
            <path d="M12 5v14M5 12h14" />
          </svg>
          คอลัมน์
        </button>
      )}
    </div>
  );
}
