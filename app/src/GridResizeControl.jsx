import { useEffect, useRef, useState } from "react";
import { gridMetrics } from "./table.js";

/* Drag a cell border to size the row above it or the column left of it.

   Every border between two tracks is a handle: the pointer shows a line along
   it and a resize cursor, pressing there starts a drag, and the track follows
   the pointer while the rest of the grid shifts so the table keeps tiling.
   The drag is one undo step (previews are never captured) and one save, same
   as the sliders in the table panel.

   Like GridAddControl it paints into an overlay above the Excalidraw canvases
   and reads scene geometry every frame, so panning/zooming keeps the line on
   the border without a React render per frame. */

/** Screen px around a border that grabs it. */
const TOLERANCE = 5;
/** Screen px outside the grid that still counts as its border. */
const EDGE_PAD = 2;
/** A row or column never gets thinner than this (scene px). */
const MIN_TRACK = 24;
/** Mousedown inside Excalidraw chrome is not a border hover. */
const IGNORE = ".panel, .Island, .App-toolbar, .App-menu, .grid-add, .relation-panel, .relation-waypoint";

/** Grid ids of plain tables — ER classes keep their own row controls. */
function tableGrids(scene) {
  const grids = new Map();
  for (const el of scene) {
    const grid = el.customData?.grid;
    if (!grid || el.isDeleted) continue;
    const isClass = el.customData?.class === true;
    grids.set(grid, (grids.get(grid) || false) || isClass);
  }
  return [...grids.entries()].filter(([, isClass]) => !isClass).map(([grid]) => grid);
}

/**
 * The border under one scene point: the nearest row bottom or column right
 * edge within TOLERANCE screen px, while the point stays on that grid.
 * `size` is the track the border would resize, `pos` the border itself.
 */
function boundaryAt(scene, x, y, zoom) {
  const tol = TOLERANCE / zoom;
  const pad = EDGE_PAD / zoom;
  let best = null;
  for (const grid of tableGrids(scene)) {
    const metrics = gridMetrics(scene, grid);
    if (!metrics) continue;
    const box = metrics.bounds;
    if (x < box.left - pad || x > box.right + pad || y < box.top - pad || y > box.bottom + pad) continue;
    for (const row of metrics.rows) {
      const pos = row.top + row.height;
      const dist = Math.abs(y - pos);
      if (dist <= tol && (!best || dist < best.dist)) {
        best = { grid, axis: "row", index: row.r, size: row.height, pos, box, dist };
      }
    }
    for (const col of metrics.cols) {
      const pos = col.left + col.width;
      const dist = Math.abs(x - pos);
      if (dist <= tol && (!best || dist < best.dist)) {
        best = { grid, axis: "col", index: col.c, size: col.width, pos, box, dist };
      }
    }
  }
  return best;
}

export default function GridResizeControl({ apiRef, canvasRef, onPreview, onCommit }) {
  const rootRef = useRef(null);
  const lineRef = useRef(null);
  const gripRef = useRef(null);
  const pointerRef = useRef(null);
  const hoverRef = useRef(null);
  const dragRef = useRef(null);
  const [visible, setVisible] = useState(false);
  const [axis, setAxis] = useState("row");
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const host = canvasRef.current;
    if (!host) return undefined;

    const toScene = (clientX, clientY, state) => {
      const rect = host.getBoundingClientRect();
      const zoom = state.zoom?.value || 1;
      return {
        x: (clientX - rect.left) / zoom - (state.scrollX || 0),
        y: (clientY - rect.top) / zoom - (state.scrollY || 0),
        zoom,
      };
    };

    const followPointer = (event) => {
      const drag = dragRef.current;
      if (!drag) return;
      const api = apiRef.current;
      if (!api) return;
      // screen delta over the zoom captured at the press: the canvas may pan a
      // little while the grid is being rebuilt, and a scene-space delta would
      // then fold that pan into the size
      const delta =
        (drag.axis === "row" ? event.clientY - drag.downY : event.clientX - drag.downX) / drag.zoom;
      drag.pos = drag.startPos + delta;
      drag.last = Math.max(MIN_TRACK, Math.round(drag.size + delta));
      if (drag.last !== drag.sent) {
        drag.sent = drag.last;
        if (onPreview) onPreview(drag.grid, drag.axis, drag.index, drag.last);
      }
    };

    const onMove = (event) => {
      pointerRef.current = { clientX: event.clientX, clientY: event.clientY };
      followPointer(event);
    };

    const endDrag = (commit) => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      setDragging(false);
      host.classList.remove("grid-resizing");
      if (commit && drag.sent != null && onCommit) onCommit(drag.grid, drag.axis, drag.index, drag.last);
      // the pointerup is followed by a click Excalidraw would read as a canvas
      // click: swallow that one so a resize never also moves the selection
      const swallow = (event) => {
        event.stopPropagation();
        event.preventDefault();
        window.removeEventListener("click", swallow, true);
      };
      window.addEventListener("click", swallow, true);
      setTimeout(() => window.removeEventListener("click", swallow, true), 400);
    };

    const onDown = (event) => {
      if (event.button !== 0) return;
      if (event.target instanceof Element && event.target.closest(IGNORE)) return;
      const api = apiRef.current;
      if (!api) return;
      const point = toScene(event.clientX, event.clientY, api.getAppState());
      const hit = boundaryAt(api.getSceneElements(), point.x, point.y, point.zoom);
      if (!hit) return;
      // the canvas must not also see this press: it would start a selection drag
      event.preventDefault();
      event.stopPropagation();
      dragRef.current = {
        grid: hit.grid,
        axis: hit.axis,
        index: hit.index,
        size: hit.size,
        downX: event.clientX,
        downY: event.clientY,
        zoom: point.zoom,
        startPos: hit.pos,
        pos: hit.pos,
        last: null,
        sent: null,
      };
      setAxis(hit.axis);
      setVisible(true);
      setDragging(true);
      host.classList.add("grid-resizing");
    };

    const onKey = (event) => {
      if (event.key === "Escape" && dragRef.current) {
        event.stopPropagation();
        endDrag(false);
      }
    };

    const onUp = (event) => {
      // take the size from the release itself: a fast drag can end before its
      // last move is reported, and committing the previous step would leave the
      // track a few pixels short of where the pointer actually stopped
      if (dragRef.current && typeof event.clientX === "number") followPointer(event);
      endDrag(true);
    };

    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    window.addEventListener("keydown", onKey, true);

    let frame = 0;
    const paint = () => {
      frame = window.requestAnimationFrame(paint);
      const api = apiRef.current;
      const el = rootRef.current;
      if (!api || !el) return;
      const state = api.getAppState();
      const zoom = state.zoom?.value || 1;
      const scrollX = state.scrollX || 0;
      const scrollY = state.scrollY || 0;

      const drag = dragRef.current;
      let hit = drag;
      if (drag) {
        // the box is read fresh every frame: the table under the line is growing
        // and the line has to keep spanning it
        const metrics = gridMetrics(api.getSceneElements(), drag.grid);
        if (metrics) hit = { ...drag, box: metrics.bounds };
      } else {
        const pointer = pointerRef.current;
        if (pointer) {
          const point = toScene(pointer.clientX, pointer.clientY, state);
          hit = boundaryAt(api.getSceneElements(), point.x, point.y, point.zoom);
        }
        const nextAxis = hit ? hit.axis : null;
        const prevAxis = hoverRef.current ? hoverRef.current.axis : null;
        hoverRef.current = hit;
        if (nextAxis !== prevAxis) {
          setVisible(Boolean(hit));
          if (hit) setAxis(hit.axis);
        }
        host.classList.toggle("grid-cursor-row", nextAxis === "row");
        host.classList.toggle("grid-cursor-col", nextAxis === "col");
      }
      if (!hit) return;

      const line = lineRef.current;
      const grip = gripRef.current;
      if (!line || !grip) return;
      const { box } = hit;
      /* the line lies on the border it belongs to and spans the whole table:
         a row border runs left-to-right along `pos`, a column border runs
         top-to-bottom along it, so each axis reads its own coordinate. */
      const left = (box.left + scrollX) * zoom;
      const top = (box.top + scrollY) * zoom;
      const width = box.width * zoom;
      const height = box.height * zoom;
      if (hit.axis === "row") {
        const y = (hit.pos + scrollY) * zoom;
        line.style.width = `${Math.round(width)}px`;
        line.style.height = "2px";
        line.style.transform = `translate(${Math.round(left)}px, ${Math.round(y) - 1}px)`;
        grip.style.transform = `translate(${Math.round(left + width / 2) - 5}px, ${Math.round(y) - 5}px)`;
      } else {
        const x = (hit.pos + scrollX) * zoom;
        line.style.width = "2px";
        line.style.height = `${Math.round(height)}px`;
        line.style.transform = `translate(${Math.round(x) - 1}px, ${Math.round(top)}px)`;
        grip.style.transform = `translate(${Math.round(x) - 5}px, ${Math.round(top + height / 2) - 5}px)`;
      }
    };

    frame = window.requestAnimationFrame(paint);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
      window.removeEventListener("keydown", onKey, true);
      host.classList.remove("grid-cursor-row", "grid-cursor-col", "grid-resizing");
    };
  }, [apiRef, canvasRef, onPreview, onCommit]);

  return (
    <div className={`grid-resize${visible ? " visible" : ""}${dragging ? " dragging" : ""}`} ref={rootRef} aria-hidden="true">
      <div className={`grid-resize-line ${axis}`} ref={lineRef} />
      <div className={`grid-resize-grip ${axis}`} ref={gripRef} />
    </div>
  );
}
