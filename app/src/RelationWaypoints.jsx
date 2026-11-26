import { useEffect, useRef, useState } from "react";
import { arrowScenePoints, setArrowScenePoints } from "./relations.js";

/* Draggable handles on a selected relation arrow, draw.io style:
   - hollow handles at each segment midpoint add a bend there
   - solid handles on existing bends move them
   The arrow keeps its frame bindings; syncRelations only re-derives the two
   bound ends, so the user's bends survive table moves, reload and undo. */

const POINT_SIZE = 12;

export default function RelationWaypoints({ apiRef, canvasRef, selected, onCommit }) {
  const rootRef = useRef(null);
  const pointRefs = useRef([]);
  const addRefs = useRef([]);
  const dragRef = useRef(null);
  const [counts, setCounts] = useState({ points: 0, add: 0 });

  useEffect(() => {
    if (!selected) return undefined;
    const host = canvasRef.current;
    if (!host) return undefined;

    let frame = 0;
    const paint = () => {
      frame = window.requestAnimationFrame(paint);
      const api = apiRef.current;
      const root = rootRef.current;
      if (!api || !root) return;

      const arrow = api
        .getSceneElements()
        .find((el) => el.id === selected.arrowId && el.type === "arrow" && !el.isDeleted);
      if (!arrow) {
        root.style.display = "none";
        return;
      }
      root.style.display = "block";

      const scene = arrowScenePoints(arrow);
      const points = Math.max(0, scene.length - 2);
      const adds = Math.max(0, scene.length - 1);
      if (points !== counts.points || adds !== counts.add) {
        setCounts({ points, add: adds });
        return;
      }

      const state = api.getAppState();
      const zoom = state.zoom?.value || 1;
      const scrollX = state.scrollX || 0;
      const scrollY = state.scrollY || 0;
      const rect = host.getBoundingClientRect();
      const toScreen = (point) => ({
        x: rect.left + (point.x + scrollX) * zoom,
        y: rect.top + (point.y + scrollY) * zoom,
      });

      for (let i = 1; i < scene.length - 1; i += 1) {
        const el = pointRefs.current[i - 1];
        if (!el) continue;
        const screen = toScreen(scene[i]);
        el.style.left = `${screen.x}px`;
        el.style.top = `${screen.y}px`;
      }
      for (let i = 0; i < scene.length - 1; i += 1) {
        const el = addRefs.current[i];
        if (!el) continue;
        const a = toScreen(scene[i]);
        const b = toScreen(scene[i + 1]);
        el.style.left = `${(a.x + b.x) / 2}px`;
        el.style.top = `${(a.y + b.y) / 2}px`;
      }
    };

    frame = window.requestAnimationFrame(paint);
    return () => {
      window.cancelAnimationFrame(frame);
      if (rootRef.current) rootRef.current.style.display = "none";
    };
  }, [apiRef, canvasRef, selected, counts.points, counts.add]);

  useEffect(() => {
    if (!selected) return undefined;

    const scenePoint = (event) => {
      const api = apiRef.current;
      const host = canvasRef.current;
      if (!api || !host) return null;
      const state = api.getAppState();
      const zoom = state.zoom?.value || 1;
      const rect = host.getBoundingClientRect();
      return {
        x: (event.clientX - rect.left) / zoom - (state.scrollX || 0),
        y: (event.clientY - rect.top) / zoom - (state.scrollY || 0),
      };
    };

    const onMove = (event) => {
      const drag = dragRef.current;
      const api = apiRef.current;
      if (!drag || !api) return;
      const point = scenePoint(event);
      if (!point) return;
      const arrow = api.getSceneElements().find((el) => el.id === drag.arrowId && !el.isDeleted);
      if (!arrow) return;
      const points = arrowScenePoints(arrow);
      if (!points[drag.index]) return;
      points[drag.index] = point;
      const next = setArrowScenePoints(api.getSceneElements(), drag.arrowId, points);
      if (next) api.updateScene({ elements: next, captureUpdate: "NEVER" });
    };

    const finish = () => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      const api = apiRef.current;
      if (!api) return;
      const final =
        api.getSceneElements().find((el) => el.id === drag.arrowId && !el.isDeleted) ?? null;
      if (!final) return;
      const finalScene = api.getSceneElements();
      // one undo step for the whole drag: rewind the uncaptured previews,
      // then capture the finished route
      api.updateScene({ elements: drag.startElements, captureUpdate: "NEVER" });
      api.updateScene({ elements: finalScene, captureUpdate: "IMMEDIATELY" });
      onCommit?.();
    };

    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", finish, true);
    window.addEventListener("pointercancel", finish, true);
    return () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", finish, true);
      window.removeEventListener("pointercancel", finish, true);
    };
  }, [apiRef, canvasRef, selected, onCommit]);

  if (!selected) return null;

  const start = (event, { pointIndex, segment }) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const api = apiRef.current;
    if (!api) return;
    const arrow = api.getSceneElements().find((el) => el.id === selected.arrowId && !el.isDeleted);
    if (!arrow) return;

    const startElements = api.getSceneElements();
    let points = arrowScenePoints(arrow);
    let index = pointIndex;

    if (segment != null) {
      const a = points[segment];
      const b = points[segment + 1];
      if (!a || !b) return;
      const bend = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      points = [...points.slice(0, segment + 1), bend, ...points.slice(segment + 1)];
      index = segment + 1;
      const next = setArrowScenePoints(api.getSceneElements(), arrow.id, points);
      if (next) api.updateScene({ elements: next, captureUpdate: "NEVER" });
    }

    if (!points[index]) return;
    dragRef.current = { arrowId: arrow.id, index, startElements };
  };

  const pointHandles = Array.from({ length: counts.points }, (_, i) => (
    <button
      key={`p${i}`}
      type="button"
      className="relation-waypoint"
      style={{ width: POINT_SIZE, height: POINT_SIZE }}
      ref={(el) => {
        pointRefs.current[i] = el;
      }}
      aria-label={`จุดปรับเส้น ${i + 1}`}
      title="ลากเพื่อปรับเส้น"
      onPointerDown={(event) => start(event, { pointIndex: i + 1 })}
      onClick={(event) => event.stopPropagation()}
    />
  ));

  const addHandles = Array.from({ length: counts.add }, (_, i) => (
    <button
      key={`a${i}`}
      type="button"
      className="relation-waypoint-add"
      ref={(el) => {
        addRefs.current[i] = el;
      }}
      aria-label={`เพิ่มจุดปรับเส้นช่วง ${i + 1}`}
      title="ลากเพื่อเพิ่มจุดปรับเส้น"
      onPointerDown={(event) => start(event, { segment: i })}
      onClick={(event) => event.stopPropagation()}
    />
  ));

  return (
    <div className="relation-waypoints" ref={rootRef} style={{ display: "none" }} aria-hidden="true">
      {addHandles}
      {pointHandles}
    </div>
  );
}
