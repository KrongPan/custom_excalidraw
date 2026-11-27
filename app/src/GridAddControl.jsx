import { useEffect, useRef, useState } from "react";
import { tableBounds } from "./table.js";

/* Two pairs of handles that ride whichever table the pointer is over: a row
   pair on the bottom edge and a column pair on the right edge, each pair
   running along the axis it changes — + adds one more, - drops the last one.
   Rows and columns are only ever added to or removed from the same table, so
   nothing spawns a second grid.

   Like GridOverlay it paints into an overlay above the Excalidraw canvases and
   reads scene geometry every frame, so panning/zooming keeps the buttons glued
   to the table without a React render per frame: only entering or leaving a
   table flips state, every other frame writes styles straight to the DOM. */

/** How far outside a grid the pointer may stray before the buttons leave. */
const HIT_PAD = 30;
/** The handles sit beside the edge, not on its border (screen px). */
const HANDLE_GAP = 10;
/** Gap between the + and - of one pair. */
const PAIR_GAP = 6;
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
    if (!grids.has(grid)) grids.set(grid, { grid, kind: "table", rows: 0, cols: 0 });
    const info = grids.get(grid);
    if (el.customData?.class === true) {
      info.kind = "class";
      // a class has no r/c on its rows: its field list is the row count
      const fields = el.customData?.classData?.fields;
      if (Array.isArray(fields)) info.rows = Math.max(info.rows, fields.length);
    }
    const { r, c } = el.customData || {};
    if (Number.isInteger(r)) info.rows = Math.max(info.rows, r + 1);
    if (Number.isInteger(c)) info.cols = Math.max(info.cols, c + 1);
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
      hit = { grid: info.grid, kind: info.kind, box, rows: info.rows, cols: info.cols };
    }
  }
  return hit;
}

function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true" focusable="false">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function MinusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true" focusable="false">
      <path d="M5 12h14" />
    </svg>
  );
}

export default function GridAddControl({ apiRef, canvasRef, onChange }) {
  const rootRef = useRef(null);
  const rowAddRef = useRef(null);
  const rowDelRef = useRef(null);
  const colAddRef = useRef(null);
  const colDelRef = useRef(null);
  const pointerRef = useRef(null);
  const hoveredRef = useRef(null);
  const [visible, setVisible] = useState(false);
  const [kind, setKind] = useState("table");
  const [counts, setCounts] = useState({ rows: 1, cols: 1 });

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
        if (hit) {
          setKind(hit.kind);
          setCounts({ rows: hit.rows, cols: hit.cols });
        }
      } else if (hit) {
        hoveredRef.current = hit;
        setCounts((prev) =>
          prev.rows === hit.rows && prev.cols === hit.cols ? prev : { rows: hit.rows, cols: hit.cols },
        );
      }
      if (!hit) return;

      const { box } = hit;
      const rowCentre = (box.left + box.width / 2 + scrollX) * zoom;
      const rowY = (box.bottom + scrollY) * zoom + HANDLE_GAP;
      const rowAdd = rowAddRef.current;
      const rowDel = rowDelRef.current;
      if (rowAdd && rowDel) {
        const pair = rowAdd.offsetWidth + PAIR_GAP + rowDel.offsetWidth;
        const left = Math.round(rowCentre - pair / 2);
        rowAdd.style.transform = `translate(${left}px, ${Math.round(rowY)}px)`;
        rowDel.style.transform = `translate(${left + rowAdd.offsetWidth + PAIR_GAP}px, ${Math.round(rowY)}px)`;
      }
      const colAdd = colAddRef.current;
      const colDel = colDelRef.current;
      if (colAdd && colDel) {
        const colX = (box.right + scrollX) * zoom + HANDLE_GAP;
        const colCentre = (box.top + box.height / 2 + scrollY) * zoom;
        const pair = colAdd.offsetHeight + PAIR_GAP + colDel.offsetHeight;
        const top = Math.round(colCentre - pair / 2);
        colAdd.style.transform = `translate(${Math.round(colX)}px, ${top}px)`;
        colDel.style.transform = `translate(${Math.round(colX)}px, ${top + colAdd.offsetHeight + PAIR_GAP}px)`;
      }
    };

    frame = window.requestAnimationFrame(paint);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove, true);
    };
  }, [apiRef, canvasRef]);

  const change = (axis, delta) => {
    const target = hoveredRef.current;
    hoveredRef.current = null;
    pointerRef.current = null;
    setVisible(false);
    if (target && onChange) onChange(target.grid, axis, target.kind, delta);
  };

  const isClass = kind === "class";
  const tabIndex = visible ? 0 : -1;
  const rowFull = counts.rows <= 1;
  const colFull = counts.cols <= 1;

  return (
    <div className={`grid-add${visible ? " visible" : ""}`} ref={rootRef} aria-hidden={!visible}>
      <button
        ref={rowAddRef}
        type="button"
        className="grid-add-btn grid-add-row"
        aria-label="เพิ่มแถว"
        title="เพิ่มแถว"
        tabIndex={tabIndex}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          change("row", 1);
        }}
      >
        <PlusIcon />
        แถว
      </button>
      <button
        ref={rowDelRef}
        type="button"
        className="grid-add-btn grid-add-del grid-add-row-del"
        aria-label="ลบแถว"
        title={rowFull ? "เหลือแถวสุดท้ายแล้ว" : "ลบแถวสุดท้าย"}
        tabIndex={tabIndex}
        disabled={rowFull}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          change("row", -1);
        }}
      >
        <MinusIcon />
        แถว
      </button>
      {isClass ? null : (
        <>
          <button
            ref={colAddRef}
            type="button"
            className="grid-add-btn grid-add-col"
            aria-label="เพิ่มคอลัมน์"
            title="เพิ่มคอลัมน์"
            tabIndex={tabIndex}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              change("col", 1);
            }}
          >
            <PlusIcon />
            คอลัมน์
          </button>
          <button
            ref={colDelRef}
            type="button"
            className="grid-add-btn grid-add-del grid-add-col-del"
            aria-label="ลบคอลัมน์"
            title={colFull ? "เหลือคอลัมน์สุดท้ายแล้ว" : "ลบคอลัมน์สุดท้าย"}
            tabIndex={tabIndex}
            disabled={colFull}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              change("col", -1);
            }}
          >
            <MinusIcon />
            คอลัมน์
          </button>
        </>
      )}
    </div>
  );
}
