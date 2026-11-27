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

export default function GridAddControl({ apiRef, canvasRef, onChange, onPick }) {
  const plusRef = useRef(null);
  const minusRowRef = useRef(null);
  const minusColRef = useRef(null);
  const pointerRef = useRef(null);
  const viewRef = useRef(null);
  // a cell that was clicked keeps its removals on screen after the pointer
  // leaves, otherwise the pills vanish on the way to them and cannot be pressed
  const pinRef = useRef(null);
  const pinPendingRef = useRef(false);
  // where the last press landed, so a release in the same spot counts as a click
  const pressRef = useRef(null);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
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
    /* The table cell under a point, read from the scene itself: the frame that
       paints the pills may not have run since the pointer moved, so the hover
       state cannot answer "which cell was pressed". */
    const cellAt = (clientX, clientY) => {
      const api = apiRef.current;
      const host = canvasRef.current;
      if (!api || !host) return null;
      const state = api.getAppState();
      const zoom = state.zoom?.value || 1;
      const sceneX = clientX / zoom - (state.scrollX || 0);
      const sceneY = clientY / zoom - (state.scrollY || 0);
      const scene = api.getSceneElements();
      let found = null;
      for (const entry of gridsOf(scene)) {
        if (entry.kind === "class") continue; // a class picks lines, not cells
        const geometry = tableGeometry(scene, entry.grid);
        if (!geometry) continue;
        const b = geometry.bounds;
        if (sceneX < b.left || sceneX > b.left + b.width) continue;
        if (sceneY < b.top || sceneY > b.top + b.height) continue;
        found = { grid: entry.grid, kind: entry.kind, geometry };
      }
      if (!found) return null;
      // A merged cell owns the lines that run through it: its centre sits exactly
      // on the boundary of the rows it covers, so without this a click on the
      // middle of a merged cell would pick the whole table. The pill still offers
      // an insert there; the press picks the cell, which is what split acts on.
      for (const el of scene) {
        if (el.isDeleted || el.customData?.grid !== found.grid) continue;
        const rowSpan = el.customData?.rowSpan || 1;
        const colSpan = el.customData?.colSpan || 1;
        if (rowSpan === 1 && colSpan === 1) continue;
        if (sceneX < el.x || sceneX > el.x + el.width) continue;
        if (sceneY < el.y || sceneY > el.y + el.height) continue;
        return { mode: "cell", kind: found.kind, grid: found.grid, row: el.customData.r | 0, col: el.customData.c | 0 };
      }
      // a press right on a border picks the whole table: the line is already the
      // table-level surface (its pill inserts), the inside of a cell is a cell
      const onLine =
        found.geometry.rowLines.some((line) => Math.abs(line - sceneY) * zoom <= TOL) ||
        found.geometry.colLines.some((line) => Math.abs(line - sceneX) * zoom <= TOL);
      if (onLine) return { mode: "grid", kind: found.kind, grid: found.grid };
      const row = found.geometry.rows.find((entry) => sceneY >= entry.top && sceneY <= entry.bottom);
      const col = found.geometry.cols.find((entry) => sceneX >= entry.left && sceneX <= entry.right);
      if (!row || !col) return null;
      return { mode: "cell", kind: found.kind, grid: found.grid, row: row.index, col: col.index };
    };

    const onDown = (event) => {
      // pressing a pill must not disturb the pin it belongs to; any other press
      // asks the next frame to re-pin under the pointer or drop the old pin
      const chrome = event.target instanceof Element && event.target.closest(IGNORE);
      // shift/meta/ctrl turns the pick into "add to the block I am building",
      // which is how a range of cells gets selected for a merge
      const additive = event.shiftKey || event.metaKey || event.ctrlKey;
      const cell = chrome ? null : cellAt(event.clientX, event.clientY);
      pressRef.current =
        event.button === 0 && !chrome && !event.altKey
          ? { x: event.clientX, y: event.clientY, cell, additive }
          : null;
      // A modifier press on a cell is building a block for a merge, not a native
      // "add this whole group to the selection": keeping Excalidraw out of the
      // press leaves the cells picked so far intact for the toggle on release.
      if (additive && cell?.mode === "cell") {
        event.preventDefault();
        event.stopPropagation();
      }
      if (event.target instanceof Element && event.target.closest(".grid-add")) return;
      pinPendingRef.current = true;
    };
    /* A click on a cell picks that one cell (modifier = add to the block); the
       table's own group selection would otherwise swallow every cell. */
    const onUp = (event) => {
      const down = pressRef.current;
      pressRef.current = null;
      if (!down || !down.cell || event.button !== 0) return;
      if (Math.abs(event.clientX - down.x) > 4 || Math.abs(event.clientY - down.y) > 4) return;
      pickRef.current?.(down.cell, { additive: down.additive });
    };
    const onLeave = () => {
      pointerRef.current = null;
    };
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      pinRef.current = null;
      pinPendingRef.current = false;
    };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerdown", onMove, true);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerdown", onMove, true);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("keydown", onKey, true);
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

    // The two removal pills for one cell/line; returns the view it painted so
    // a click can pin exactly that cell.
    const paintCell = (geometry, kind, grid, rowEntry, colEntry) => {
      const minusRow = minusRowRef.current;
      const minusCol = minusColRef.current;
      const plus = plusRef.current;
      const api = apiRef.current;
      const host = canvasRef.current;
      if (!api || !host || !rowEntry) return null;
      const state = api.getAppState();
      const zoom = state.zoom?.value || 1;
      const scrollX = state.scrollX || 0;
      const scrollY = state.scrollY || 0;
      const hostW = host.clientWidth;
      const hostH = host.clientHeight;
      const screenX = (x) => (x + scrollX) * zoom;
      const screenY = (y) => (y + scrollY) * zoom;
      const rowWidth = minusRow?.offsetWidth || 62;
      const colWidth = minusCol?.offsetWidth || 62;
      const height = minusRow?.offsetHeight || 26;
      const x = kind === "class" ? screenX(geometry.bounds.left) : screenX(colEntry.left);
      const y = screenY(rowEntry.top) - HANDLE_GAP - height;
      const boxRow = {
        x: Math.max(EDGE, Math.min(x, hostW - rowWidth - EDGE)),
        y: Math.max(EDGE, Math.min(y, hostH - height - EDGE)),
      };
      place(minusRow, boxRow, true);
      if (kind === "class") {
        place(minusCol, null, false);
      } else {
        place(minusCol, { x: Math.max(EDGE, Math.min(boxRow.x + rowWidth + PAIR_GAP, hostW - colWidth - EDGE)), y: boxRow.y }, true);
      }
      place(plus, null, false);

      const next = {
        mode: "cell",
        kind,
        grid,
        rows: geometry.rows.length,
        cols: geometry.cols.length,
        row: rowEntry.index,
        col: kind === "class" ? 0 : Number(colEntry.index),
        rowLine: kind === "class" ? { section: rowEntry.section, index: rowEntry.lineIndex } : null,
      };
      const same =
        viewRef.current &&
        viewRef.current.mode === "cell" &&
        viewRef.current.grid === next.grid &&
        viewRef.current.row === next.row &&
        viewRef.current.col === next.col;
      viewRef.current = same ? viewRef.current : next;
      setView((old) => {
        if (!old || old.mode !== "cell" || old.grid !== next.grid || old.row !== next.row || old.col !== next.col) return next;
        return old;
      });
      return next;
    };

    /** Re-draw the pinned cell's removals, wherever the pointer went. */
    const paintPinned = () => {
      const pin = pinRef.current;
      const api = apiRef.current;
      if (!pin || !api) return false;
      const scene = api.getSceneElements();
      const geometry = pin.kind === "class" ? classGeometry(scene, pin.grid) : tableGeometry(scene, pin.grid);
      const row = geometry?.rows[pin.row];
      if (!geometry || !row) {
        pinRef.current = null;
        return false;
      }
      const col = pin.kind === "class" ? { left: geometry.bounds.left } : geometry.cols[pin.col];
      if (!col) {
        pinRef.current = null;
        return false;
      }
      paintCell(geometry, pin.kind, pin.grid, row, col);
      return true;
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
        // the pointer sits over the panel or the board chrome (or left the
        // window). A fresh press there means nothing is under it to pin, but a
        // pin made earlier has to survive the pointer walking away.
        if (pinPendingRef.current) {
          pinRef.current = null;
          pinPendingRef.current = false;
          clear();
          return;
        }
        if (pinRef.current && paintPinned()) return;
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
        // a click on empty canvas drops the pin; otherwise it keeps the
        // removals of the cell that was clicked last
        if (pinPendingRef.current) {
          pinRef.current = null;
          pinPendingRef.current = false;
        }
        if (pinRef.current && paintPinned()) return;
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
        // clicking beside a line asks for an insert, not a pinned removal
        if (pinPendingRef.current) {
          pinRef.current = null;
          pinPendingRef.current = false;
        }
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

      const built = paintCell(geometry, kind, grid, cell.row, cell.col);
      if (pinPendingRef.current) {
        pinRef.current = built;
        pinPendingRef.current = false;
      }
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
    // the grid is rebuilt after this, so both the pin and the hovered cell are
    // stale (the rows/columns around them may have shifted)
    pinRef.current = null;
    pinPendingRef.current = false;
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
