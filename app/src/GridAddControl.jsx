import { useEffect, useRef, useState } from "react";
import { gridMetrics, tableBounds } from "./table.js";

/* Handles that ride whichever grid the pointer is over, split by what the
   pointer is on:

   - on a grid line (an outer border or a line between two tracks) one "+" pill
     sits at the line's start end: a row line grows the pill to the left of the
     table, a column line above it. Clicking inserts a track *at that line*, so
     a row can be added anywhere, not only at the top or the bottom.
   - on a cell the two "-" pills appear above the cell and drop that row or that
     column. A class is one column of lines: its "-" drops the line under the
     pointer and its "+" adds a field/method line at the hovered boundary.

   It paints into an overlay above the Excalidraw canvases and reads scene
   geometry every frame, so panning/zooming keeps the pills glued to the grid
   without a React render per frame: only a change of hit (line, cell, track)
   flips state, every other frame writes styles straight to the DOM. */

/** How far outside a grid the pointer may stray before the pills leave. */
const HIT_PAD = 30;
/** How close (screen px) the pointer must be to a line to offer an insert. */
const TOL = 6;
/** A pill sits this far outside the line/grid it belongs to (screen px). */
const HANDLE_GAP = 10;
/** Gap between the two "-" pills. */
const PAIR_GAP = 6;
/** Keep pills this far inside the canvas edge. */
const EDGE = 6;
/** Mousedown inside Excalidraw chrome is not a grid hover. */
const IGNORE = ".grid-add, .relation-panel, .panel, .Island, .App-toolbar, .App-menu";

/** One entry per grid in the scene: a plain table or an ER class. */
function gridsOf(scene) {
  const map = new Map();
  for (const el of scene) {
    if (el.isDeleted) continue;
    const grid = el.customData?.grid;
    if (!grid) continue;
    let info = map.get(grid);
    if (!info) {
      info = { grid, kind: "table" };
      map.set(grid, info);
    }
    if (el.customData?.class === true) info.kind = "class";
  }
  return [...map.values()];
}

/** Rows, columns and the lines between them, in scene coordinates. */
function tableGeometry(scene, grid) {
  const metrics = gridMetrics(tableBoundsScene(scene, grid), grid);
  if (!metrics) return null;
  const bounds = metrics.bounds;
  const rows = metrics.rows.map((row) => ({
    index: row.r,
    top: row.top,
    bottom: row.top + row.height,
    left: bounds.left,
    right: bounds.left + bounds.width,
  }));
  const cols = metrics.cols.map((col) => ({
    index: col.c,
    left: col.left,
    right: col.left + col.width,
    top: bounds.top,
    bottom: bounds.top + bounds.height,
  }));
  // insert boundary k is the top of track k, or the far edge of the last one
  return {
    kind: "table",
    bounds,
    rows,
    cols,
    rowLines: rows.map((row) => row.top).concat(bounds.top + bounds.height),
    colLines: cols.map((col) => col.left).concat(bounds.left + bounds.width),
  };
}

const tableBoundsScene = (scene, grid) => scene.filter((el) => el.customData?.grid === grid);

/** A class is a list of text lines: fields first, then methods. */
function classGeometry(scene, grid) {
  const els = tableBoundsScene(scene, grid);
  const lines = els
    .filter((el) => el.type === "text" && !el.isDeleted && el.customData?.classLine)
    .map((el) => ({
      section: el.customData.classLine,
      index: Number(el.customData.index) || 0,
      top: el.y,
      bottom: el.y + el.height,
    }))
    .sort((a, b) => a.top - b.top);
  if (!lines.length) return null;
  const bounds = tableBounds(els, grid) ?? {
    left: Math.min(...els.map((el) => el.x)),
    top: Math.min(...els.map((el) => el.y)),
    width: 1,
    height: 1,
  };
  const box = {
    left: bounds.left,
    top: bounds.top,
    width: bounds.width,
    height: bounds.height,
  };
  return {
    kind: "class",
    bounds: box,
    rows: lines.map((line, i) => ({
      index: i,
      top: line.top,
      bottom: line.bottom,
      section: line.section,
      lineIndex: line.index,
    })),
    cols: [],
    rowLines: lines.map((line) => line.top).concat(lines[lines.length - 1].bottom),
    colLines: [],
  };
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
  const plusRef = useRef(null);
  const minusRowRef = useRef(null);
  const minusColRef = useRef(null);
  const pointerRef = useRef(null);
  const viewRef = useRef(null);
  const [view, setView] = useState(null);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;

  useEffect(() => {
    const host = canvasRef.current;
    if (!host) return undefined;
    const onMove = (event) => {
      // chasing a pill must not drop the grid it belongs to
      if (event.target instanceof Element && event.target.closest(".grid-add")) return;
      pointerRef.current = { x: event.clientX, y: event.clientY };
      if (event.target instanceof Element && event.target.closest(IGNORE)) {
        pointerRef.current = null;
      }
    };
    const onLeave = () => {
      pointerRef.current = null;
    };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerdown", onMove, true);
    window.addEventListener("blur", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerdown", onMove, true);
      window.removeEventListener("blur", onLeave);
    };
  }, [canvasRef]);

  useEffect(() => {
    let frame = 0;
    const place = (el, boxed, visible) => {
      if (!el) return;
      el.style.opacity = visible ? "1" : "0";
      el.style.pointerEvents = visible ? "auto" : "none";
      if (!boxed) return;
      el.style.transform = `translate(${Math.round(boxed.x)}px, ${Math.round(boxed.y)}px)`;
    };

    const paint = () => {
      frame = window.requestAnimationFrame(paint);
      const api = apiRef.current;
      const host = canvasRef.current;
      const pointer = pointerRef.current;
      const plus = plusRef.current;
      const minusRow = minusRowRef.current;
      const minusCol = minusColRef.current;
      if (!api || !host) return;

      const clear = () => {
        place(plus, null, false);
        place(minusRow, null, false);
        place(minusCol, null, false);
      };

      if (!pointer) {
        clear();
        return;
      }

      const state = api.getAppState();
      const zoom = state.zoom?.value || 1;
      const scrollX = state.scrollX || 0;
      const scrollY = state.scrollY || 0;
      const sceneX = pointer.x / zoom - scrollX;
      const sceneY = pointer.y / zoom - scrollY;
      const hostW = host.clientWidth;
      const hostH = host.clientHeight;
      const scene = api.getSceneElements();

      let target = null;
      for (const entry of gridsOf(scene)) {
        const geometry = entry.kind === "class" ? classGeometry(scene, entry.grid) : tableGeometry(scene, entry.grid);
        if (!geometry) continue;
        const b = geometry.bounds;
        const pad = HIT_PAD / zoom;
        if (sceneX < b.left - pad || sceneX > b.left + b.width + pad) continue;
        if (sceneY < b.top - pad || sceneY > b.top + b.height + pad) continue;
        target = { grid: entry.grid, kind: entry.kind, geometry };
      }
      if (!target) {
        clear();
        setView((old) => (old ? null : old));
        viewRef.current = null;
        return;
      }

      const { geometry, kind, grid } = target;
      const screenX = (x) => (x + scrollX) * zoom;
      const screenY = (y) => (y + scrollY) * zoom;

      // nearest line the pointer is close to, rows winning an exact tie
      let line = null;
      for (const axis of ["row", "col"]) {
        const list = axis === "row" ? geometry.rowLines : geometry.colLines;
        for (let at = 0; at < list.length; at++) {
          const pos = axis === "row" ? screenY(list[at]) : screenX(list[at]);
          const distance = Math.abs((axis === "row" ? pointer.y : pointer.x) - pos);
          if (distance > TOL) continue;
          // the pointer also has to lie beside the grid, not past its far end
          const left = screenX(geometry.bounds.left);
          const top = screenY(geometry.bounds.top);
          const width = geometry.bounds.width * zoom;
          const height = geometry.bounds.height * zoom;
          if (axis === "row" && (pointer.x < left - HIT_PAD || pointer.x > left + width + HIT_PAD)) continue;
          if (axis === "col" && (pointer.y < top - HIT_PAD || pointer.y > top + height + HIT_PAD)) continue;
          if (!line || distance < line.distance) line = { axis, at, pos, distance };
        }
      }

      if (line) {
        const width = plus?.offsetWidth || 62;
        const height = plus?.offsetHeight || 26;
        let x;
        let y;
        if (line.axis === "row") {
          x = screenX(geometry.bounds.left) - HANDLE_GAP - width;
          y = line.pos - height / 2;
        } else {
          x = line.pos - width / 2;
          y = screenY(geometry.bounds.top) - HANDLE_GAP - height;
        }
        x = Math.max(EDGE, Math.min(x, hostW - width - EDGE));
        y = Math.max(EDGE, Math.min(y, hostH - height - EDGE));
        place(plus, { x, y }, true);
        place(minusRow, null, false);
        place(minusCol, null, false);
        // a class inserts before the line that starts at this boundary
        const boundary = geometry.rows[Math.min(line.at, geometry.rows.length - 1)];
        const insert =
          kind === "class" && boundary ? { section: boundary.section, index: boundary.lineIndex } : null;
        const next = {
          mode: "line",
          axis: line.axis,
          at: line.at,
          kind,
          grid,
          insert,
          rows: geometry.rows.length,
          cols: geometry.cols.length,
        };
        viewRef.current = next;
        setView((old) =>
          old && old.mode === "line" && old.axis === next.axis && old.at === next.at && old.kind === next.kind && old.grid === next.grid
            ? old
            : next,
        );
        return;
      }

      // a cell (or, for a class, the line under the pointer) offers the removals
      const row = geometry.rows.find((entry) => sceneY >= entry.top && sceneY <= entry.bottom);
      const col = geometry.cols.find((entry) => sceneX >= entry.left && sceneX <= entry.right);
      const onGrid = sceneX >= geometry.bounds.left && sceneX <= geometry.bounds.left + geometry.bounds.width;
      const inGrid = sceneY >= geometry.bounds.top && sceneY <= geometry.bounds.top + geometry.bounds.height;
      const cell = row && (kind === "class" ? onGrid : col) && inGrid ? { row, col } : null;
      if (!cell) {
        clear();
        viewRef.current = null;
        setView((old) => (old ? null : old));
        return;
      }

      const rowWidth = minusRow?.offsetWidth || 62;
      const colWidth = minusCol?.offsetWidth || 62;
      const height = minusRow?.offsetHeight || 26;
      const x = kind === "class" ? screenX(geometry.bounds.left) : screenX(cell.col.left);
      const y = screenY(cell.row.top) - HANDLE_GAP - height;
      const boxRow = { x: Math.max(EDGE, Math.min(x, hostW - rowWidth - EDGE)), y: Math.max(EDGE, Math.min(y, hostH - height - EDGE)) };
      place(minusRow, boxRow, true);
      if (kind === "class") {
        place(minusCol, null, false);
      } else {
        const boxCol = {
          x: Math.max(EDGE, Math.min(boxRow.x + rowWidth + PAIR_GAP, hostW - colWidth - EDGE)),
          y: boxRow.y,
        };
        place(minusCol, boxCol, true);
      }
      place(plus, null, false);

      const next = {
        mode: "cell",
        kind,
        grid,
        rows: geometry.rows.length,
        cols: geometry.cols.length,
        row: kind === "class" ? cell.row.index : Number(cell.row.index),
        col: kind === "class" ? 0 : Number(cell.col.index),
        rowLine: kind === "class" ? { section: cell.row.section, index: cell.row.lineIndex } : null,
      };
      const sameCell =
        viewRef.current &&
        viewRef.current.mode === "cell" &&
        viewRef.current.grid === next.grid &&
        viewRef.current.row === next.row &&
        viewRef.current.col === next.col;
      viewRef.current = sameCell ? viewRef.current : next;
      setView((old) => {
        if (!old || old.mode !== "cell" || old.grid !== next.grid || old.row !== next.row || old.col !== next.col) return next;
        return old;
      });
    };

    frame = window.requestAnimationFrame(paint);
    return () => window.cancelAnimationFrame(frame);
  }, [apiRef, canvasRef]);

  /* keep the labels and disabled flags in step with the hovered surface */
  useEffect(() => {
    const plus = plusRef.current;
    const minusRow = minusRowRef.current;
    const minusCol = minusColRef.current;
    if (!plus || !minusRow || !minusCol) return;
    plus.disabled = false;
    minusRow.disabled = Boolean(view && view.mode === "cell" && view.rows <= 1);
    minusCol.disabled = Boolean(view && view.mode === "cell" && (view.cols <= 1 || view.kind === "class"));
  }, [view]);

  const fire = (event, axis, delta) => {
    event.stopPropagation();
    const current = viewRef.current;
    if (!current) return;
    const grid = current.grid;
    const kind = current.kind;
    if (current.mode === "line") {
      changeRef.current?.(grid, axis, kind, delta, current.at, current.insert ?? null);
      return;
    }
    if (current.mode === "cell") {
      const at = axis === "row" ? current.row : current.col;
      changeRef.current?.(grid, axis, kind, delta, at, current.rowLine);
    }
  };

  const line = view && view.mode === "line" ? view : null;
  const cell = view && view.mode === "cell" ? view : null;

  return (
    <div className="grid-add" aria-hidden="false">
      <button
        ref={plusRef}
        type="button"
        className="grid-add-btn grid-add-insert"
        data-axis={line?.axis}
        data-at={line?.at}
        aria-label="แทรกแถวหรือคอลัมน์ตรงเส้นนี้"
        title="แทรกแถว/คอลัมน์ตรงเส้นนี้"
        tabIndex={-1}
        style={{ opacity: 0, pointerEvents: "none" }}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => fire(event, line?.axis || "row", 1)}
      >
        <PlusIcon />
        {line?.axis === "col" ? "คอลัมน์" : "แถว"}
      </button>
      <button
        ref={minusRowRef}
        type="button"
        className="grid-add-btn grid-add-del grid-add-row-del"
        data-axis="row"
        data-at={cell?.row}
        aria-label="ลบแถวที่ชี้"
        title="ลบแถวที่ชี้"
        tabIndex={-1}
        style={{ opacity: 0, pointerEvents: "none" }}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => fire(event, "row", -1)}
      >
        <MinusIcon />
        แถว
      </button>
      <button
        ref={minusColRef}
        type="button"
        className="grid-add-btn grid-add-del grid-add-col-del"
        data-axis="col"
        data-at={cell?.col}
        aria-label="ลบคอลัมน์ที่ชี้"
        title="ลบคอลัมน์ที่ชี้"
        tabIndex={-1}
        style={{ opacity: 0, pointerEvents: "none" }}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => fire(event, "col", -1)}
      >
        <MinusIcon />
        คอลัมน์
      </button>
    </div>
  );
}
