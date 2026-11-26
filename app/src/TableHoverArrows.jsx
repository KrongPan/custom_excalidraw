import { useEffect, useRef, useState } from "react";
import { isGridCell, isGridFrame, tableBounds } from "./table.js";

/* Four clone handles that ride the edge of whichever table the pointer is over.
   Like GridOverlay it paints into an overlay above the Excalidraw canvases and
   reads scene geometry every frame, so panning/zooming keeps the buttons glued
   to the table without a React render per frame: only entering or leaving a
   table flips state, every other frame writes styles straight to the DOM. */

/** How far outside a table the pointer may stray before the buttons leave. */
const HIT_PAD = 18;
/** Mousedown inside Excalidraw chrome is not a table hover. */
const IGNORE = ".relation-panel, .panel, .Island, .App-toolbar, .App-menu";

const DIRECTIONS = [
  { id: "left", label: "โคลนตารางไปทางซ้าย", path: "M19 12H5M11 6l-6 6 6 6" },
  { id: "right", label: "โคลนตารางไปทางขวา", path: "M5 12h14M13 6l6 6-6 6" },
  { id: "top", label: "โคลนตารางไปด้านบน", path: "M12 19V5M6 11l6-6 6 6" },
  { id: "bottom", label: "โคลนตารางไปด้านล่าง", path: "M12 5v14M6 13l6 6 6-6" },
];

/** Scene-space box of a frame element. */
function frameBox(el) {
  return {
    left: el.x,
    top: el.y,
    right: el.x + el.width,
    bottom: el.y + el.height,
    centerX: el.x + el.width / 2,
    centerY: el.y + el.height / 2,
  };
}

/**
 * Topmost table under one scene point. Frames are the real bounds; tables from
 * before frames existed fall back to their cells. Scene order decides, so the
 * last hit wins like a z-order pick.
 */
function tableAt(scene, x, y, pad = HIT_PAD) {
  const framed = new Set();
  for (const el of scene) {
    if (isGridFrame(el) && el.customData?.grid) framed.add(el.customData.grid);
  }

  const candidates = [];
  const seenLegacy = new Set();
  for (const el of scene) {
    if (isGridFrame(el) && el.customData?.grid) {
      candidates.push({ grid: el.customData.grid, box: frameBox(el) });
      continue;
    }
    if (!isGridCell(el)) continue;
    const grid = el.customData.grid;
    if (framed.has(grid) || seenLegacy.has(grid)) continue;
    seenLegacy.add(grid);
    const bounds = tableBounds(scene, grid);
    if (bounds) candidates.push({ grid, box: bounds });
  }

  let hit = null;
  for (const candidate of candidates) {
    const { box } = candidate;
    if (x >= box.left - pad && x <= box.right + pad && y >= box.top - pad && y <= box.bottom + pad) {
      hit = candidate;
    }
  }
  return hit;
}

export default function TableHoverArrows({ apiRef, canvasRef, onClone }) {
  const buttonRefs = useRef({});
  const pointerRef = useRef(null);
  const hoveredRef = useRef(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const host = canvasRef.current;
    if (!host) return undefined;

    const onMove = (event) => {
      if (event.target instanceof Element && event.target.closest(IGNORE)) {
        pointerRef.current = null;
        return;
      }
      pointerRef.current = { clientX: event.clientX, clientY: event.clientY };
    };
    const onLeave = () => {
      pointerRef.current = null;
    };
    host.addEventListener("pointermove", onMove, true);
    host.addEventListener("pointerleave", onLeave, true);

    let frame = 0;
    const paint = () => {
      frame = window.requestAnimationFrame(paint);
      const api = apiRef.current;
      if (!api) return;

      const pointer = pointerRef.current;
      const state = api.getAppState();
      const zoom = state.zoom?.value || 1;
      const scrollX = state.scrollX || 0;
      const scrollY = state.scrollY || 0;
      const busy =
        state.editingTextElement ||
        state.editingLinearElement ||
        state.selectedElementsAreBeingDragged ||
        state.newElement ||
        state.selectionElement ||
        state.resizingElement;
      const selecting = state.activeTool?.type === "selection" && !busy;

      let hit = null;
      if (selecting && pointer) {
        const rect = host.getBoundingClientRect();
        // same mapping App uses for the clicked cell (see the activeCell handler)
        const sceneX = (pointer.clientX - rect.left) / zoom - scrollX;
        const sceneY = (pointer.clientY - rect.top) / zoom - scrollY;
        // the handles are a fixed 24 CSS px: pad in scene units so the outer
        // half of a handle still counts at low zoom
        hit = tableAt(api.getSceneElements(), sceneX, sceneY, HIT_PAD / zoom);
      }

      const prev = hoveredRef.current;
      const prevGrid = prev ? prev.grid : null;
      const nextGrid = hit ? hit.grid : null;
      if (nextGrid !== prevGrid) {
        hoveredRef.current = hit;
        setVisible(Boolean(hit));
      } else if (hit) {
        hoveredRef.current = hit;
      }
      if (!hit) return;

      const { box } = hit;
      const toScreen = (sceneX, sceneY) => [(sceneX + scrollX) * zoom, (sceneY + scrollY) * zoom];
      const place = (direction, sceneX, sceneY) => {
        const el = buttonRefs.current[direction];
        if (!el) return;
        const [left, top] = toScreen(sceneX, sceneY);
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
      };
      place("left", box.left, box.centerY);
      place("right", box.right, box.centerY);
      place("top", box.centerX, box.top);
      place("bottom", box.centerX, box.bottom);
    };

    frame = window.requestAnimationFrame(paint);
    return () => {
      window.cancelAnimationFrame(frame);
      host.removeEventListener("pointermove", onMove, true);
      host.removeEventListener("pointerleave", onLeave, true);
    };
  }, [apiRef, canvasRef]);

  const handleClone = (direction) => {
    const target = hoveredRef.current;
    if (!target || !onClone) return;
    onClone(target.grid, direction);
    // the clone lands under the pointer; wait for the next move before showing
    // handles for whatever table ends up there
    hoveredRef.current = null;
    pointerRef.current = null;
    setVisible(false);
  };

  return (
    <div className={`table-hover-arrows${visible ? " visible" : ""}`} aria-hidden={!visible}>
      {DIRECTIONS.map((direction) => (
        <button
          key={direction.id}
          type="button"
          className="table-hover-arrow"
          data-direction={direction.id}
          ref={(el) => {
            buttonRefs.current[direction.id] = el;
          }}
          aria-label={direction.label}
          title={direction.label}
          tabIndex={visible ? 0 : -1}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            handleClone(direction.id);
          }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
          >
            <path d={direction.path} />
          </svg>
        </button>
      ))}
    </div>
  );
}
