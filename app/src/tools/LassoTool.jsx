import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { viewportCoordsToSceneCoords } from "@excalidraw/excalidraw";

/* Freehand lasso selection.
   0.18.1 has no lasso in its ToolType union, so the app keeps its own mode:
   while armed an overlay sits over the Excalidraw canvases, draws the drag as a
   dashed polygon and turns the released loop into a normal selection through
   the public API. The overlay stops Excalidraw from starting a box selection. */

const LASSO_COLOR = "#6965db";
const HINT = "ลากเส้นรอบสิ่งที่ต้องการเลือก · Esc เพื่อยกเลิก";

export const IconLasso = () => (
  <svg
    width={17}
    height={17}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <ellipse cx="10.6" cy="9.2" rx="7.6" ry="5.6" transform="rotate(-14 10.6 9.2)" />
    <path d="M17.4 12.6c1.4 1.5 1.7 3 .8 3.9-1 1-2.9.9-4.5-.1" />
  </svg>
);

/* Ray casting: does the closed polygon contain (x, y)? */
function insidePolygon(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [ax, ay] = polygon[i];
    const [bx, by] = polygon[j];
    if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) {
      inside = !inside;
    }
  }
  return inside;
}

/* A shape is caught when its bounding-box centre falls in the loop, or when
   the whole box does. Elements without any area have nothing to select. */
function hitsPolygon(element, polygon) {
  if (!element.width && !element.height) return false;
  const { x, y, width, height } = element;
  if (insidePolygon(x + width / 2, y + height / 2, polygon)) return true;
  return [
    [x, y],
    [x + width, y],
    [x + width, y + height],
    [x, y + height],
  ].every(([px, py]) => insidePolygon(px, py, polygon));
}

/* Scene ids caught by the loop. A bound label stands for its container, so a
   lasso over one table cell selects the cell, not the text inside it; a group
   comes along whole the way Excalidraw's own selection does. */
function collectSelection(elements, polygon) {
  const byId = new Map();
  for (const element of elements) {
    if (!element.isDeleted) byId.set(element.id, element);
  }
  const ids = new Set();
  for (const element of elements) {
    if (element.isDeleted) continue;
    const target =
      element.type === "text" && element.containerId ? byId.get(element.containerId) : element;
    if (!target || target.isDeleted) continue;
    if (hitsPolygon(target, polygon)) ids.add(target.id);
  }
  const groupIds = new Set();
  for (const id of ids) {
    for (const groupId of byId.get(id).groupIds || []) groupIds.add(groupId);
  }
  if (groupIds.size) {
    for (const element of elements) {
      if (element.isDeleted) continue;
      if ((element.groupIds || []).some((groupId) => groupIds.has(groupId))) ids.add(element.id);
    }
  }
  return ids;
}

export default function LassoTool({
  apiRef,
  canvasRef,
  host,
  armed: armedProp,
  onArmedChange,
  showButton = true,
}) {
  const [armedLocal, setArmedLocal] = useState(false);
  /* The owner may drive the mode (the overflow menu does) or let the component
     own it (the standalone button did). One state either way. */
  const controlled = armedProp !== undefined;
  const armed = controlled ? armedProp : armedLocal;
  const setArmed = useCallback(
    (next) => {
      const value = typeof next === "function" ? next(controlled ? armedProp : armedLocal) : next;
      if (controlled) onArmedChange?.(value);
      else setArmedLocal(value);
    },
    [controlled, armedProp, armedLocal, onArmedChange],
  );
  const [points, setPoints] = useState([]);
  const dragRef = useRef(null);

  const reset = useCallback(() => {
    dragRef.current = null;
    setPoints([]);
    setArmed(false);
  }, [setArmed]);

  /* Escape leaves the scene alone: no drag, no selection change. Picking
     another tool in the toolbar leaves lasso mode too, the way a real tool
     switch would. */
  useEffect(() => {
    if (!armed) return undefined;
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      reset();
    };
    const onClick = (event) => {
      if (event.target.closest?.(".tools-lasso")) return;
      if (event.target.closest?.(".App-toolbar")) reset();
    };
    window.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("click", onClick);
    };
  }, [armed, reset]);

  const applySelection = useCallback(
    (clientPoints) => {
      const api = apiRef.current;
      if (!api) return;
      const appState = api.getAppState();
      const polygon = clientPoints.map(({ x, y }) => {
        const scene = viewportCoordsToSceneCoords({ clientX: x, clientY: y }, appState);
        return [scene.x, scene.y];
      });
      const selectedElementIds = {};
      for (const id of collectSelection(api.getSceneElements(), polygon)) {
        selectedElementIds[id] = true;
      }
      api.setActiveTool({ type: "selection" });
      api.updateScene({ appState: { selectedElementIds } });
    },
    [apiRef],
  );

  const localPoint = (element, event) => {
    const rect = element.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const onPointerDown = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const local = localPoint(event.currentTarget, event);
    dragRef.current = {
      pointerId: event.pointerId,
      client: [{ x: event.clientX, y: event.clientY }],
      local: [local],
    };
    setPoints([local]);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* capture is a nicety; the drag still ends on pointerup */
    }
  };

  const onPointerMove = (event) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const local = localPoint(event.currentTarget, event);
    const last = drag.local[drag.local.length - 1];
    if (Math.hypot(local.x - last.x, local.y - last.y) < 2) return;
    drag.client.push({ x: event.clientX, y: event.clientY });
    drag.local.push(local);
    setPoints(drag.local.slice());
  };

  const onPointerUp = (event) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* already released with the pointer */
    }
    dragRef.current = null;
    /* A tap or a two-point scribble is not a loop: disarm and change nothing. */
    if (drag.client.length < 3) {
      reset();
      return;
    }
    applySelection(drag.client);
    reset();
  };

  const toggle = () => {
    if (armed) {
      reset();
      return;
    }
    setPoints([]);
    setArmed(true);
  };

  const canvasEl = canvasRef?.current;
  const svgPoints = points.map(({ x, y }) => `${x},${y}`).join(" ");

  const overlay =
    armed && canvasEl
      ? createPortal(
          <div
            className="lasso-overlay"
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 5,
              cursor: "crosshair",
              touchAction: "none",
              userSelect: "none",
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={reset}
            onContextMenu={(event) => event.preventDefault()}
          >
            <svg
              width="100%"
              height="100%"
              style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
              aria-hidden="true"
            >
              {points.length > 1 && (
                <polyline
                  points={svgPoints}
                  fill="rgba(105, 101, 219, 0.08)"
                  stroke={LASSO_COLOR}
                  strokeWidth={1.75}
                  strokeDasharray="6 4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}
            </svg>
            <div
              style={{
                position: "absolute",
                left: "50%",
                bottom: 18,
                transform: "translateX(-50%)",
                padding: "6px 12px",
                borderRadius: 999,
                background: "rgba(255, 255, 255, 0.86)",
                border: "1px solid rgba(31, 36, 71, 0.12)",
                boxShadow: "0 6px 18px rgba(31, 36, 71, 0.12)",
                color: "#4a4a57",
                font: "12px/1.4 Assistant, system-ui, sans-serif",
                whiteSpace: "nowrap",
                pointerEvents: "none",
              }}
            >
              {HINT}
            </div>
          </div>,
          canvasEl,
        )
      : null;

  return (
    <>
      {showButton &&
        host &&
        createPortal(
          <button
            type="button"
            className={`tools-table tools-lasso${armed ? " active" : ""}`}
            onClick={toggle}
            aria-label="เลือกแบบบ่วง"
            aria-pressed={armed}
            title="เลือกแบบบ่วง (ลากเส้นรอบสิ่งที่ต้องการเลือก)"
          >
            <IconLasso />
          </button>,
          host,
        )}
      {overlay}
    </>
  );
}
