import { useEffect, useRef, useState } from "react";
import { tableBounds } from "./table.js";

/* Eight handles that ride whichever grid the pointer is over: a row pair above
   and below the top and bottom edges, a column pair to the left and right of
   the left and right edges. + adds one track on that side, - drops the track on
   that side, and every pair only ever edits the same grid, so nothing spawns a
   second table.

   It paints into an overlay above the Excalidraw canvases and
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

/** The four places a pair can sit; `start` is the edge that adds before the rest. */
const PAIRS = [
  { side: "top", axis: "row", edge: "start", word: "แถว" },
  { side: "bottom", axis: "row", edge: "end", word: "แถว" },
  { side: "left", axis: "col", edge: "start", word: "คอลัมน์" },
  { side: "right", axis: "col", edge: "end", word: "คอลัมน์" },
];

const SIDE_TH = { top: "ด้านบน", bottom: "ด้านล่าง", left: "ด้านซ้าย", right: "ด้านขวา" };
const DROP_TH = { top: "บนสุด", bottom: "ล่างสุด", left: "ซ้ายสุด", right: "ขวาสุด" };

export default function GridAddControl({ apiRef, canvasRef, onChange }) {
  const rootRef = useRef(null);
  const buttons = useRef({});
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

    /** Lay a horizontal pair out around the middle of `centreX`. */
    const along = (side, centreX, y) => {
      const add = buttons.current[`${side}:add`];
      const del = buttons.current[`${side}:del`];
      if (!add || !del) return;
      const total = add.offsetWidth + PAIR_GAP + del.offsetWidth;
      const left = Math.round(centreX - total / 2);
      const top = Math.round(y);
      add.style.transform = `translate(${left}px, ${top}px)`;
      del.style.transform = `translate(${left + add.offsetWidth + PAIR_GAP}px, ${top}px)`;
    };

    /** Stack a vertical pair around the middle of `centreY`. */
    const across = (side, x, centreY) => {
      const add = buttons.current[`${side}:add`];
      const del = buttons.current[`${side}:del`];
      if (!add || !del) return;
      const total = add.offsetHeight + PAIR_GAP + del.offsetHeight;
      const left = Math.round(x);
      const top = Math.round(centreY - total / 2);
      add.style.transform = `translate(${left}px, ${top}px)`;
      del.style.transform = `translate(${left}px, ${top + add.offsetHeight + PAIR_GAP}px)`;
    };

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
      const left = (box.left + scrollX) * zoom;
      const top = (box.top + scrollY) * zoom;
      const width = box.width * zoom;
      const height = box.height * zoom;
      const rowAdd = buttons.current["top:add"];
      const colAdd = buttons.current["left:add"];

      // rows: the pairs run along the horizontal edges, above and below
      along("top", left + width / 2, top - HANDLE_GAP - (rowAdd?.offsetHeight || 0));
      along("bottom", left + width / 2, top + height + HANDLE_GAP);
      // columns: the pairs run along the vertical edges, left and right
      across("left", left - HANDLE_GAP - (colAdd?.offsetWidth || 0), top + height / 2);
      across("right", left + width + HANDLE_GAP, top + height / 2);
    };

    frame = window.requestAnimationFrame(paint);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove, true);
    };
  }, [apiRef, canvasRef]);

  const change = (axis, delta, edge) => {
    const target = hoveredRef.current;
    hoveredRef.current = null;
    pointerRef.current = null;
    setVisible(false);
    if (target && onChange) onChange(target.grid, axis, target.kind, delta, edge);
  };

  const isClass = kind === "class";
  const tabIndex = visible ? 0 : -1;
  const rowFull = counts.rows <= 1;
  const colFull = counts.cols <= 1;

  return (
    <div className={`grid-add${visible ? " visible" : ""}`} ref={rootRef} aria-hidden={!visible}>
      {PAIRS.map(({ side, axis, edge, word }) => {
        if (isClass && axis === "col") return null;
        const full = axis === "row" ? rowFull : colFull;
        return (
          <span key={side}>
            <button
              ref={(node) => {
                buttons.current[`${side}:add`] = node;
              }}
              type="button"
              className="grid-add-btn"
              data-axis={axis}
              data-side={side}
              data-delta="1"
              aria-label={`เพิ่ม${word}${SIDE_TH[side]}`}
              title={`เพิ่ม${word}${SIDE_TH[side]}`}
              tabIndex={tabIndex}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                change(axis, 1, edge);
              }}
            >
              <PlusIcon />
              {word}
            </button>
            <button
              ref={(node) => {
                buttons.current[`${side}:del`] = node;
              }}
              type="button"
              className="grid-add-btn grid-add-del"
              data-axis={axis}
              data-side={side}
              data-delta="-1"
              aria-label={`ลบ${word}${DROP_TH[side]}`}
              title={full ? `เหลือ${word}สุดท้ายแล้ว` : `ลบ${word}${DROP_TH[side]}`}
              tabIndex={tabIndex}
              disabled={full}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                change(axis, -1, edge);
              }}
            >
              <MinusIcon />
              {word}
            </button>
          </span>
        );
      })}
    </div>
  );
}
