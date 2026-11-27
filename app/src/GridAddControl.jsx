import { useEffect, useRef, useState } from "react";
import { gridMetrics, tableBounds } from "./table.js";

/* Handles that ride whichever grid the pointer is over, split by what the
   pointer is on:

   - on a grid line (an outer border or a line between two tracks) one "+" pill
     sits at the line's start end: a row line grows the pill to the left of the
     table, a column line above it. Clicking inserts a track *at that line*, so
     a row can be added anywhere, not only at the top or the bottom.
   - on the outer border of a table, seen from OUTSIDE it, one "-" pill drops
     the track the pointer is beside: the left/right border drops that row,
     the top/bottom border drops that column. A pointer inside a cell shows
     none, however close to the edge it sits; the pill itself sits outside the
     grid, clear of every cell, so it never swallows a click meant for a cell.
     A class is one column of lines: its "-" drops the field/method line under
     the pointer and its "+" adds a line at the hovered boundary.

   It paints into an overlay above the Excalidraw canvases and reads scene
   geometry every frame, so panning/zooming keeps the pills glued to the grid
   without a React render per frame: only a change of hit (line, edge, track)
   flips state, every other frame writes styles straight to the DOM. */

/** How far outside a grid the pointer may stray before the pills leave. */
const HIT_PAD = 30;
/** How close (screen px) the pointer must be to a line for it to count. */
const TOL = 6;
/** A pill sits this far outside the line/grid it belongs to (screen px). */
const HANDLE_GAP = 10;
/** How far outside a border the removal shows: the pointer has to be outside
    the grid, and this band has to reach the pill sitting HANDLE_GAP out. */
const EDGE_PAD = 16;
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

/** Same hover hit, so a frame that moved nothing does not re-render React. */
function signatureOf(next) {
  if (!next) return "";
  const line = next.line ? `${next.line.axis}${next.line.at}` : "-";
  const edge = next.edge ? `${next.edge.side}${next.edge.axis}${next.edge.at}` : "-";
  return `${next.grid}|${line}|${edge}`;
}

export default function GridAddControl({ apiRef, canvasRef, onChange, onPick }) {
  const plusRef = useRef(null);
  const minusRowRef = useRef(null);
  const minusColRef = useRef(null);
  const pointerRef = useRef(null);
  const viewRef = useRef(null);
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
      const canvas = canvasRef.current;
      if (!api || !canvas) return null;
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
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerdown", onMove, true);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("blur", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerdown", onMove, true);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("blur", onLeave);
    };
  }, [canvasRef]);

  useEffect(() => {
    let frame = 0;
    const place = (el, boxed, visible) => {
      if (!el) return;
      el.style.opacity = visible ? "1" : "0";
      if (!visible) {
        el.style.pointerEvents = "none";
        return;
      }
      el.style.pointerEvents = "auto";
      if (boxed) el.style.transform = `translate(${Math.round(boxed.x)}px, ${Math.round(boxed.y)}px)`;
    };

    const paint = () => {
      frame = window.requestAnimationFrame(paint);
      const api = apiRef.current;
      const host = canvasRef.current;
      const plus = plusRef.current;
      const minusRow = minusRowRef.current;
      const minusCol = minusColRef.current;
      if (!api || !host) return;

      const clear = () => {
        place(plus, null, false);
        place(minusRow, null, false);
        place(minusCol, null, false);
      };
      const reset = () => {
        clear();
        viewRef.current = null;
        setView((old) => (old ? null : old));
      };

      const pointer = pointerRef.current;
      if (!pointer) {
        reset();
        return;
      }

      const state = api.getAppState();
      const zoom = state.zoom?.value || 1;
      const scrollX = state.scrollX || 0;
      const scrollY = state.scrollY || 0;
      const sceneX = pointer.x / zoom - scrollX;
      const sceneY = pointer.y / zoom - scrollY;
      const screenX = (x) => (x + scrollX) * zoom;
      const screenY = (y) => (y + scrollY) * zoom;
      const hostW = host.clientWidth;
      const hostH = host.clientHeight;
      const scene = api.getSceneElements();

      const pad = HIT_PAD / zoom;
      const candidates = [];
      for (const entry of gridsOf(scene)) {
        const geometry = entry.kind === "class" ? classGeometry(scene, entry.grid) : tableGeometry(scene, entry.grid);
        if (!geometry) continue;
        const b = geometry.bounds;
        if (sceneX < b.left - pad || sceneX > b.left + b.width + pad) continue;
        if (sceneY < b.top - pad || sceneY > b.top + b.height + pad) continue;
        candidates.push({ grid: entry.grid, kind: entry.kind, geometry });
      }
      if (!candidates.length) {
        reset();
        return;
      }

      /* Two tables can lie next to (or over) each other, so the grid to paint
         is the one whose line the pointer is closest to, not simply the last
         one in the scene: a pointer that sits inside one table while touching
         another's border would otherwise paint on the wrong table. */
      let target = null;
      let line = null;
      let inside = null;
      for (const entry of candidates) {
        const { geometry } = entry;
        const left = (geometry.bounds.left + scrollX) * zoom;
        const top = (geometry.bounds.top + scrollY) * zoom;
        const right = left + geometry.bounds.width * zoom;
        const bottom = top + geometry.bounds.height * zoom;
        // "inside" means clearly past the border: half a pixel on the line is
        // still the border, so a pointer landing exactly on it counts as
        // outside and gets that track's removal instead of nothing
        if (
          !inside &&
          pointer.x > left + 0.5 &&
          pointer.x < right - 0.5 &&
          pointer.y > top + 0.5 &&
          pointer.y < bottom - 0.5
        ) {
          inside = entry;
        }
        for (const axis of ["row", "col"]) {
          // the pointer also has to lie beside the grid, not past its far end
          const beside =
            axis === "row"
              ? pointer.x >= left - HIT_PAD && pointer.x <= right + HIT_PAD
              : pointer.y >= top - HIT_PAD && pointer.y <= bottom + HIT_PAD;
          if (!beside) continue;
          const list = axis === "row" ? geometry.rowLines : geometry.colLines;
          for (let at = 0; at < list.length; at++) {
            const pos = axis === "row" ? (list[at] + scrollY) * zoom : (list[at] + scrollX) * zoom;
            const distance = Math.abs((axis === "row" ? pointer.y : pointer.x) - pos);
            if (distance > TOL) continue;
            // a nearer line wins, and rows win an exact tie
            const tie = line && Math.abs(distance - line.distance) <= 0.5 && axis === "row" && line.axis !== "row";
            if (!line || distance < line.distance - 0.5 || tie) {
              line = { axis, at, pos, distance };
              target = entry;
            }
          }
        }
      }
      /* The removal lives on a border seen from OUTSIDE the table: a pointer
         inside a cell shows none, however close to the edge it sits. The band
         reaches EDGE_PAD out, enough to walk from the border onto the pill
         (which sits HANDLE_GAP out) without losing it on the way. */
      const rowAt = (geometry, y) => {
        let best = null;
        for (const row of geometry.rows) {
          const rowTop = screenY(row.top);
          const rowBottom = screenY(row.bottom);
          if (y >= rowTop && y <= rowBottom) return { row, distance: 0 };
          const distance = Math.min(Math.abs(y - rowTop), Math.abs(y - rowBottom));
          if (!best || distance < best.distance) best = { row, distance };
        }
        return best;
      };
      const colAt = (geometry, x) => {
        let best = null;
        for (const col of geometry.cols) {
          const colLeft = screenX(col.left);
          const colRight = screenX(col.right);
          if (x >= colLeft && x <= colRight) return { col, distance: 0 };
          const distance = Math.min(Math.abs(x - colLeft), Math.abs(x - colRight));
          if (!best || distance < best.distance) best = { col, distance };
        }
        return best;
      };
      const edgeHitFor = (entry) => {
        const geo = entry.geometry;
        const gridLeft = screenX(geo.bounds.left);
        const gridTop = screenY(geo.bounds.top);
        const gridRight = gridLeft + geo.bounds.width * zoom;
        const gridBottom = gridTop + geo.bounds.height * zoom;
        const sides = [];
        if (pointer.y >= gridTop - TOL && pointer.y <= gridBottom + TOL) {
          if (pointer.x <= gridLeft + 0.5 && gridLeft - pointer.x <= EDGE_PAD) {
            sides.push({ side: "left", axis: "row", distance: Math.max(0, gridLeft - pointer.x) });
          }
          if (pointer.x >= gridRight - 0.5 && pointer.x - gridRight <= EDGE_PAD) {
            sides.push({ side: "right", axis: "row", distance: Math.max(0, pointer.x - gridRight) });
          }
        }
        // a class is one column of lines: only its side edges have a track to drop
        if (pointer.x >= gridLeft - TOL && pointer.x <= gridRight + TOL && geo.cols.length) {
          if (pointer.y <= gridTop + 0.5 && gridTop - pointer.y <= EDGE_PAD) {
            sides.push({ side: "top", axis: "col", distance: Math.max(0, gridTop - pointer.y) });
          }
          if (pointer.y >= gridBottom - 0.5 && pointer.y - gridBottom <= EDGE_PAD) {
            sides.push({ side: "bottom", axis: "col", distance: Math.max(0, pointer.y - gridBottom) });
          }
        }
        sides.sort((a, b) => a.distance - b.distance);
        const side = sides[0];
        if (!side) return null;
        if (side.axis === "row") {
          const hit = rowAt(geo, pointer.y);
          if (!hit) return null;
          return {
            side: side.side,
            axis: "row",
            at: hit.row.index,
            distance: side.distance,
            line:
              entry.kind === "class" && hit.row.section
                ? { section: hit.row.section, index: hit.row.lineIndex }
                : null,
          };
        }
        const hit = colAt(geo, pointer.x);
        if (!hit) return null;
        return { side: side.side, axis: "col", at: hit.col.index, distance: side.distance, line: null };
      };

      let edge = null;
      if (line) {
        // a border line carries the insert and, from outside, the removal too
        edge = edgeHitFor(target);
      } else if (inside) {
        // inside a cell: nothing rides it, however close to the border
        target = inside;
      } else {
        // outside every grid: the nearest border band wins, not the last grid
        for (const entry of candidates) {
          const hit = edgeHitFor(entry);
          if (hit && (!edge || hit.distance < edge.distance - 0.5)) {
            edge = hit;
            target = entry;
          }
        }
        if (!target) target = candidates[candidates.length - 1];
      }

      const { geometry, kind, grid } = target;
      const left = screenX(geometry.bounds.left);
      const top = screenY(geometry.bounds.top);
      const width = geometry.bounds.width * zoom;
      const height = geometry.bounds.height * zoom;
      const right = left + width;
      const bottom = top + height;

      let insert = null;
      if (line) {
        const w = plus?.offsetWidth || 62;
        const h = plus?.offsetHeight || 26;
        let x;
        let y;
        if (line.axis === "row") {
          x = left - HANDLE_GAP - w;
          y = line.pos - h / 2;
        } else {
          x = line.pos - w / 2;
          y = top - HANDLE_GAP - h;
        }
        x = Math.max(EDGE, Math.min(x, hostW - w - EDGE));
        y = Math.max(EDGE, Math.min(y, hostH - h - EDGE));
        place(plus, { x, y }, true);
        // a class inserts before the line that starts at this boundary
        const boundary = geometry.rows[Math.min(line.at, geometry.rows.length - 1)];
        insert = kind === "class" && boundary ? { section: boundary.section, index: boundary.lineIndex } : null;
      } else {
        place(plus, null, false);
      }

      if (edge?.axis === "row") {
        const row = geometry.rows.find((entry) => entry.index === edge.at);
        const w = minusRow?.offsetWidth || 62;
        const h = minusRow?.offsetHeight || 26;
        const midY = screenY((row.top + row.bottom) / 2);
        let x = edge.side === "left" ? left - HANDLE_GAP - w : right + HANDLE_GAP;
        x = Math.max(EDGE, Math.min(x, hostW - w - EDGE));
        const y = Math.max(EDGE, Math.min(midY - h / 2, hostH - h - EDGE));
        place(minusRow, { x, y }, true);
        place(minusCol, null, false);
      } else if (edge?.axis === "col") {
        const col = geometry.cols.find((entry) => entry.index === edge.at);
        const w = minusCol?.offsetWidth || 62;
        const h = minusCol?.offsetHeight || 26;
        const midX = screenX((col.left + col.right) / 2);
        const x = Math.max(EDGE, Math.min(midX - w / 2, hostW - w - EDGE));
        let y = edge.side === "top" ? top - HANDLE_GAP - h : bottom + HANDLE_GAP;
        y = Math.max(EDGE, Math.min(y, hostH - h - EDGE));
        place(minusCol, { x, y }, true);
        place(minusRow, null, false);
      } else {
        place(minusRow, null, false);
        place(minusCol, null, false);
      }

      const next = {
        grid,
        kind,
        rows: geometry.rows.length,
        cols: geometry.cols.length,
        line: line ? { axis: line.axis, at: line.at, insert } : null,
        edge,
      };
      const signature = signatureOf(next);
      if (signature !== signatureOf(viewRef.current)) {
        viewRef.current = next;
        setView(next);
      }
    };

    frame = window.requestAnimationFrame(paint);
    return () => window.cancelAnimationFrame(frame);
  }, [apiRef, canvasRef]);

  /* the last track cannot be dropped */
  useEffect(() => {
    const minusRow = minusRowRef.current;
    const minusCol = minusColRef.current;
    if (!minusRow || !minusCol) return;
    minusRow.disabled = Boolean(view && view.rows <= 1);
    minusCol.disabled = Boolean(view && (view.cols <= 1 || view.kind === "class"));
  }, [view]);

  const fire = (event, which) => {
    event.stopPropagation();
    const current = viewRef.current;
    if (!current) return;
    // the grid is rebuilt after this, so the hovered track is stale (the
    // rows/columns around it may have shifted) and so is any board selection
    // (element ids are positional and would land on another cell)
    apiRef.current?.updateScene({
      appState: { selectedElementIds: {}, selectedGroupIds: {}, editingGroupId: null },
      captureUpdate: "NEVER",
    });
    if (which === "insert") {
      if (!current.line) return;
      changeRef.current?.(current.grid, current.line.axis, current.kind, 1, current.line.at, current.line.insert ?? null);
      return;
    }
    const edge = current.edge;
    if (!edge || edge.axis !== which) return;
    changeRef.current?.(current.grid, edge.axis, current.kind, -1, edge.at, edge.line ?? null);
  };

  const line = view?.line ?? null;
  const edge = view?.edge ?? null;

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
        onClick={(event) => fire(event, "insert")}
      >
        <PlusIcon />
        {line?.axis === "col" ? "คอลัมน์" : "แถว"}
      </button>
      <button
        ref={minusRowRef}
        type="button"
        className="grid-add-btn grid-add-del grid-add-row-del"
        data-axis="row"
        data-at={edge?.axis === "row" ? edge.at : undefined}
        aria-label="ลบแถวที่ชี้"
        title="ลบแถวที่ชี้"
        tabIndex={-1}
        style={{ opacity: 0, pointerEvents: "none" }}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => fire(event, "row")}
      >
        <MinusIcon />
        แถว
      </button>
      <button
        ref={minusColRef}
        type="button"
        className="grid-add-btn grid-add-del grid-add-col-del"
        data-axis="col"
        data-at={edge?.axis === "col" ? edge.at : undefined}
        aria-label="ลบคอลัมน์ที่ชี้"
        title="ลบคอลัมน์ที่ชี้"
        tabIndex={-1}
        style={{ opacity: 0, pointerEvents: "none" }}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => fire(event, "col")}
      >
        <MinusIcon />
        คอลัมน์
      </button>
    </div>
  );
}
