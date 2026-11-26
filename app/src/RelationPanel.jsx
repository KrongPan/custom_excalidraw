import { useEffect, useRef } from "react";
import { RELATION_PRESETS } from "./relations.js";

/* Cardinality picker for the single selected relation arrow. It floats over the
   canvas and re-reads the arrow box every frame, so it stays glued while the
   arrow is dragged, the board pans or the zoom changes. */
export default function RelationPanel({ apiRef, canvasRef, selected, onApply }) {
  const rootRef = useRef(null);

  useEffect(() => {
    if (!selected) return undefined;
    const host = canvasRef.current;
    if (!host) return undefined;

    let frame = 0;
    const paint = () => {
      frame = window.requestAnimationFrame(paint);
      const api = apiRef.current;
      const el = rootRef.current;
      if (!api || !el) return;

      const arrow = api
        .getSceneElements()
        .find((entry) => entry.id === selected.arrowId && entry.type === "arrow" && !entry.isDeleted);
      if (!arrow) {
        // the relation is gone (undo, delete): leave nothing clickable behind
        el.style.opacity = "0";
        el.style.visibility = "hidden";
        el.style.pointerEvents = "none";
        return;
      }

      const state = api.getAppState();
      const zoom = state.zoom?.value || 1;
      const scrollX = state.scrollX || 0;
      const scrollY = state.scrollY || 0;
      const hostW = host.clientWidth;
      const hostH = host.clientHeight;
      const panelW = el.offsetWidth || 248;
      const panelH = el.offsetHeight || 0;

      const arrowLeft = (arrow.x + scrollX) * zoom;
      const arrowTop = (arrow.y + scrollY) * zoom;
      const arrowW = arrow.width * zoom;
      const arrowH = arrow.height * zoom;
      const arrowCx = arrowLeft + arrowW / 2;
      const arrowBottom = arrowTop + arrowH;

      // keep the panel below Excalidraw's top toolbar band and hide it when the
      // selected arrow has been panned completely out of view
      const TOP_SAFE = 58;
      if (
        arrowLeft + arrowW < 0 ||
        arrowLeft > hostW ||
        arrowTop + arrowH < 0 ||
        arrowTop > hostH
      ) {
        el.style.opacity = "0";
        el.style.visibility = "hidden";
        el.style.pointerEvents = "none";
        return;
      }

      let left = arrowCx - panelW / 2;
      left = Math.min(Math.max(4, left), Math.max(4, hostW - panelW - 4));
      // preferred above the line; drop below when the head would leave the board
      let top = arrowTop - panelH - 10;
      if (top < TOP_SAFE) top = arrowBottom + 10;
      top = Math.min(Math.max(TOP_SAFE, top), Math.max(TOP_SAFE, hostH - panelH - 4));

      el.style.left = `${Math.round(left)}px`;
      el.style.top = `${Math.round(top)}px`;
      el.style.opacity = "1";
      el.style.visibility = "visible";
      el.style.pointerEvents = "auto";
    };

    frame = window.requestAnimationFrame(paint);
    return () => window.cancelAnimationFrame(frame);
  }, [apiRef, canvasRef, selected]);

  if (!selected) return null;

  return (
    <div
      className="relation-panel"
      ref={rootRef}
      role="group"
      aria-label="เลือกหัวเส้นความสัมพันธ์"
      style={{ visibility: "hidden" }}
      // the canvas must not read these clicks as "clicked empty space" and
      // deselect the arrow the panel is editing
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="relation-title">ความสัมพันธ์</div>
      <div className="relation-options">
        {RELATION_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className="relation-option"
            data-preset={preset.id}
            aria-pressed={selected.preset === preset.id}
            onClick={() => onApply?.(selected.arrowId, preset.id)}
          >
            {preset.label}
          </button>
        ))}
      </div>
    </div>
  );
}
