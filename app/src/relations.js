/* ------------------------------------------------------------- relations */
/**
 * Pure helpers that connect tables with native Excalidraw arrows.
 *
 * A relation is an arrow whose `customData.relation` names the two grids and
 * whose start/end bindings point at their transparent frames. Nothing here
 * touches React, the DOM or the Excalidraw API, so `scripts/test-relations.mjs`
 * can exercise the whole geometry in node.
 */
import {
  buildGrid,
  bumpElement,
  ensureGridFrame,
  gridMetrics,
  isGridCell,
  isGridFrame,
  newGridId,
  tableBounds,
} from "./table.js";
import { buildClass, readClassSpec } from "./class.js";

/** Distance between a cloned table and its source, in scene px. */
const CLONE_GAP = 140;
/** Arrow endpoints stop just outside a frame so the arrowhead stays visible. */
const BIND_GAP = 4;
const ARROW_INK = "#495057";

export const RELATION_PRESETS = [
  { id: "one-one", label: "1 : 1", start: "crowfoot_one", end: "crowfoot_one" },
  { id: "one-many", label: "1 : N", start: "crowfoot_one", end: "crowfoot_many" },
  { id: "many-one", label: "N : 1", start: "crowfoot_many", end: "crowfoot_one" },
  { id: "many-many", label: "N : N", start: "crowfoot_many", end: "crowfoot_many" },
];

const round = (n) => Math.round(n * 100) / 100;
const randInt = (n) => Math.floor(Math.random() * n);
const near = (a, b) => Math.abs(a - b) <= 0.5;

let arrowSeq = 0;
function newArrowId() {
  arrowSeq += 1;
  return `rel${arrowSeq.toString(36)}${randInt(1e9).toString(36)}`;
}

function isRelationArrow(el) {
  if (!el || el.type !== "arrow" || el.isDeleted) return false;
  const rel = el.customData?.relation;
  return Boolean(rel?.fromGrid && rel?.toGrid);
}

/** Scene-space box of one table frame. */
function frameBox(frame) {
  const left = frame.x;
  const top = frame.y;
  const right = frame.x + frame.width;
  const bottom = frame.y + frame.height;
  return {
    left,
    top,
    right,
    bottom,
    width: frame.width,
    height: frame.height,
    centerX: (left + right) / 2,
    centerY: (top + bottom) / 2,
  };
}

/** Arrow bbox + local points for any scene-space polyline. */
function arrowGeometryFromPoints(points) {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = round(Math.min(...xs));
  const y = round(Math.min(...ys));
  return {
    x,
    y,
    width: round(Math.max(...xs) - x),
    height: round(Math.max(...ys) - y),
    points: points.map((point) => [round(point.x - x), round(point.y - y)]),
  };
}

/** Arrow bbox + local points for two scene-space endpoints. */
function arrowGeometry(start, end) {
  return arrowGeometryFromPoints([start, end]);
}

/** Scene-space points of a relation arrow, endpoints included. */
export function arrowScenePoints(arrow) {
  if (!arrow || !Array.isArray(arrow.points)) return [];
  return arrow.points.map(([x, y]) => ({ x: arrow.x + x, y: arrow.y + y }));
}

/**
 * Set a relation arrow's scene-space polyline (first/last are the bound ends,
 * anything between is a user waypoint). Returns a new elements array or null.
 */
export function setArrowScenePoints(elements, arrowId, points) {
  const list = Array.isArray(elements) ? elements : [];
  const arrow = list.find((el) => el.id === arrowId && el.type === "arrow" && !el.isDeleted);
  if (!arrow || !Array.isArray(points) || points.length < 2) return null;
  const geometry = arrowGeometryFromPoints(points);
  return list.map((el) => (el === arrow ? bumpElement(el, geometry) : el));
}

/** Nearest facing sides of two frames: horizontal wins on a tie. */
function facingEndpoints(from, to) {
  const dx = to.centerX - from.centerX;
  const dy = to.centerY - from.centerY;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { start: { x: from.right + BIND_GAP, y: from.centerY }, end: { x: to.left - BIND_GAP, y: to.centerY } }
      : { start: { x: from.left - BIND_GAP, y: from.centerY }, end: { x: to.right + BIND_GAP, y: to.centerY } };
  }
  return dy >= 0
    ? { start: { x: from.centerX, y: from.bottom + BIND_GAP }, end: { x: to.centerX, y: to.top - BIND_GAP } }
    : { start: { x: from.centerX, y: from.top - BIND_GAP }, end: { x: to.centerX, y: to.bottom + BIND_GAP } };
}

/** Facing sides for one explicit clone direction. */
function directionEndpoints(from, to, direction) {
  switch (direction) {
    case "left":
      return { start: { x: from.left - BIND_GAP, y: from.centerY }, end: { x: to.right + BIND_GAP, y: to.centerY } };
    case "top":
      return { start: { x: from.centerX, y: from.top - BIND_GAP }, end: { x: to.centerX, y: to.bottom + BIND_GAP } };
    case "bottom":
      return { start: { x: from.centerX, y: from.bottom + BIND_GAP }, end: { x: to.centerX, y: to.top - BIND_GAP } };
    case "right":
    default:
      return { start: { x: from.right + BIND_GAP, y: from.centerY }, end: { x: to.left - BIND_GAP, y: to.centerY } };
  }
}

function makeRelationArrow({ id, endpoints, fromFrame, toFrame, fromGrid, toGrid }) {
  const geometry = arrowGeometry(endpoints.start, endpoints.end);
  return {
    id,
    type: "arrow",
    x: geometry.x,
    y: geometry.y,
    width: geometry.width,
    height: geometry.height,
    angle: 0,
    strokeColor: ARROW_INK,
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1.5,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: randInt(2 ** 31),
    version: 1,
    versionNonce: randInt(2 ** 31),
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
    points: geometry.points,
    lastCommittedPoint: null,
    startBinding: { elementId: fromFrame.id, focus: 0, gap: BIND_GAP },
    endBinding: { elementId: toFrame.id, focus: 0, gap: BIND_GAP },
    startArrowhead: "crowfoot_one",
    endArrowhead: "crowfoot_one",
    elbowed: false,
    customData: { relation: { fromGrid, toGrid } },
  };
}

/**
 * Read the relation a native arrow carries.
 * @returns {{arrowId: string, fromGrid: string, toGrid: string, preset: string|null}|null}
 */
export function describeRelation(arrow) {
  const rel = arrow?.customData?.relation;
  if (!arrow || arrow.type !== "arrow" || !rel?.fromGrid || !rel?.toGrid) return null;
  const start = arrow.startArrowhead ?? null;
  const end = arrow.endArrowhead ?? null;
  const preset = RELATION_PRESETS.find((p) => p.start === start && p.end === end);
  return {
    arrowId: arrow.id,
    fromGrid: rel.fromGrid,
    toGrid: rel.toGrid,
    preset: preset ? preset.id : null,
  };
}

/**
 * Clone one table's structure (rows/cols, track sizes, colour, header flag,
 * title/subtitle — never the cell text) and connect source and clone with one
 * native arrow.
 *
 * @param {object[]} elements
 * @param {string} sourceGridId
 * @param {"left"|"right"|"top"|"bottom"} direction
 * @returns {{elements: object[], selectedId: string, cloneGridId: string, arrowId: string}}
 */
export function cloneAndConnect(elements, sourceGridId, direction) {
  const list = Array.isArray(elements) ? elements : [];
  if (!["left", "right", "top", "bottom"].includes(direction)) {
    throw new Error(`ทิศทางโคลนไม่ถูกต้อง: ${direction}`);
  }
  const classFrame = list.find(
    (el) => isGridFrame(el, sourceGridId) && el.customData?.class === true,
  );
  if (classFrame) return cloneClassAndConnect(list, sourceGridId, direction, classFrame);
  // body size only: buildGrid adds the title height itself, so passing the
  // frame bounds here would count the title twice and a 520x220 default would
  // squash a table the user resized
  const metrics = gridMetrics(list, sourceGridId);
  const bounds = tableBounds(list, sourceGridId);
  if (!metrics || !bounds) throw new Error("ตารางต้นทางยังไม่มีช่องให้โคลน");

  let out = ensureGridFrame(list, sourceGridId, { create: true }) ?? list;
  const cells = out.filter((el) => isGridCell(el, sourceGridId));
  if (!cells.length) throw new Error("ตารางต้นทางยังไม่มีช่องให้โคลน");

  const rows = Math.max(...cells.map((el) => el.customData.r | 0)) + 1;
  const cols = Math.max(...cells.map((el) => el.customData.c | 0)) + 1;
  const meta = cells[0].customData;
  const titleEl = out.find(
    (el) => el.type === "text" && !el.isDeleted && el.customData?.grid === sourceGridId && el.customData?.title,
  );
  const subtitleEl = out.find(
    (el) => el.type === "text" && !el.isDeleted && el.customData?.grid === sourceGridId && el.customData?.subtitle,
  );

  const cloneGridId = newGridId();
  const built = buildGrid({
    columns: cols,
    rows,
    width: metrics.bounds.width,
    height: metrics.bounds.height,
    color: meta.color,
    headerRow: meta.headerRow,
    title: titleEl?.text ?? "",
    subtitle: subtitleEl?.text ?? "",
    gridId: cloneGridId,
    idPrefix: cloneGridId,
    rowHeights: metrics.rows.map((row) => row.height),
    colWidths: metrics.cols.map((col) => col.width),
  });

  const cloneFrameId = `${cloneGridId}-frame`;
  const cloneFrameTemplate = built.elements.find((el) => el.id === cloneFrameId);
  if (!cloneFrameTemplate) throw new Error("สร้างกรอบตารางใหม่ไม่สำเร็จ");

  const cloneW = cloneFrameTemplate.width;
  const cloneH = cloneFrameTemplate.height;
  let dx;
  let dy;
  if (direction === "right") {
    dx = bounds.right + CLONE_GAP;
    dy = bounds.centerY - cloneH / 2;
  } else if (direction === "left") {
    dx = bounds.left - CLONE_GAP - cloneW;
    dy = bounds.centerY - cloneH / 2;
  } else if (direction === "bottom") {
    dx = bounds.centerX - cloneW / 2;
    dy = bounds.bottom + CLONE_GAP;
  } else {
    dx = bounds.centerX - cloneW / 2;
    dy = bounds.top - CLONE_GAP - cloneH;
  }

  const placedClone = built.elements.map((el) => ({ ...el, x: round(el.x + dx), y: round(el.y + dy) }));
  const sourceFrame = out.find((el) => isGridFrame(el, sourceGridId));
  const cloneFrame = placedClone.find((el) => el.id === cloneFrameId);
  if (!sourceFrame || !cloneFrame) throw new Error("สร้างกรอบตารางใหม่ไม่สำเร็จ");

  const arrowId = newArrowId();
  const arrow = makeRelationArrow({
    id: arrowId,
    endpoints: directionEndpoints(frameBox(sourceFrame), frameBox(cloneFrame), direction),
    fromFrame: sourceFrame,
    toFrame: cloneFrame,
    fromGrid: sourceGridId,
    toGrid: cloneGridId,
  });

  const combined = [...out, ...placedClone, arrow];
  // let the shared pass wire boundElements and re-derive the endpoints, so a
  // fresh relation and a repaired one always look the same
  const synced = syncRelations(combined) ?? combined;
  return { elements: synced, selectedId: cloneFrameId, cloneGridId, arrowId };
}

/** Clone a UML class node: class name + width, empty fields/methods. */
function cloneClassAndConnect(list, sourceGridId, direction, sourceFrame) {
  const spec = readClassSpec(list, sourceGridId);
  const sourceBounds = tableBounds(list, sourceGridId);
  if (!spec || !sourceBounds) throw new Error("ตารางต้นทางยังไม่มีข้อมูลให้โคลน");

  const cloneGridId = newGridId();
  const built = buildClass({
    gridId: cloneGridId,
    title: spec.title,
    fields: [],
    methods: [],
    width: spec.width,
    collapsed: false,
  });
  const cloneFrameTemplate = built.elements.find((el) => el.id === built.frameId);
  if (!cloneFrameTemplate) throw new Error("สร้าง class ใหม่ไม่สำเร็จ");

  const cloneW = cloneFrameTemplate.width;
  const cloneH = cloneFrameTemplate.height;
  let dx;
  let dy;
  if (direction === "right") {
    dx = sourceBounds.right + CLONE_GAP;
    dy = sourceBounds.centerY - cloneH / 2;
  } else if (direction === "left") {
    dx = sourceBounds.left - CLONE_GAP - cloneW;
    dy = sourceBounds.centerY - cloneH / 2;
  } else if (direction === "bottom") {
    dx = sourceBounds.centerX - cloneW / 2;
    dy = sourceBounds.bottom + CLONE_GAP;
  } else {
    dx = sourceBounds.centerX - cloneW / 2;
    dy = sourceBounds.top - CLONE_GAP - cloneH;
  }

  const placedClone = built.elements.map((el) => ({
    ...el,
    x: round(el.x + dx),
    y: round(el.y + dy),
  }));
  const cloneFrame = placedClone.find((el) => el.id === built.frameId);
  if (!cloneFrame) throw new Error("สร้าง class ใหม่ไม่สำเร็จ");

  const arrowId = newArrowId();
  const arrow = makeRelationArrow({
    id: arrowId,
    endpoints: directionEndpoints(frameBox(sourceFrame), frameBox(cloneFrame), direction),
    fromFrame: sourceFrame,
    toFrame: cloneFrame,
    fromGrid: sourceGridId,
    toGrid: cloneGridId,
  });
  const combined = [...list, ...placedClone, arrow];
  const synced = syncRelations(combined) ?? combined;
  return {
    elements: synced,
    selectedId: cloneFrame.id,
    cloneGridId,
    arrowId,
  };
}

/**
 * Repair every relation after the scene changed: recreate missing frames from
 * their cells, fix bindings/endpoints, and rebuild each frame's `boundElements`.
 * The pass is tolerance-based (0.5px) and returns null when nothing moved, so it
 * is safe to run from onChange.
 *
 * @returns {object[]|null}
 */
export function syncRelations(elements) {
  if (!Array.isArray(elements) || !elements.length) return null;
  if (!elements.some(isRelationArrow)) return null;

  let out = elements.slice();
  let changed = false;
  let byId = new Map(out.map((el, i) => [el.id, i]));

  const setElement = (next) => {
    const at = byId.get(next.id);
    if (at == null) return;
    out[at] = next;
  };

  const gridIds = [];
  for (const arrow of out.filter(isRelationArrow)) {
    const rel = arrow.customData.relation;
    if (!gridIds.includes(rel.fromGrid)) gridIds.push(rel.fromGrid);
    if (!gridIds.includes(rel.toGrid)) gridIds.push(rel.toGrid);
  }

  for (const gridId of gridIds) {
    const next = ensureGridFrame(out, gridId, { create: true });
    if (next) {
      out = next;
      byId = new Map(out.map((el, i) => [el.id, i]));
      changed = true;
    }
  }

  const frameOf = (gridId) => out.find((el) => isGridFrame(el, gridId)) ?? null;

  for (const arrow of out.filter(isRelationArrow)) {
    const rel = arrow.customData.relation;
    const fromFrame = frameOf(rel.fromGrid);
    const toFrame = frameOf(rel.toGrid);
    // a grid the user deleted for good is not recreated: the line stays as a
    // leftover the person can remove, never silently deletes their work
    if (!fromFrame || !toFrame) continue;

    const startBinding = {
      ...(arrow.startBinding || {}),
      elementId: fromFrame.id,
      focus: arrow.startBinding?.focus ?? 0,
      gap: BIND_GAP,
    };
    const endBinding = {
      ...(arrow.endBinding || {}),
      elementId: toFrame.id,
      focus: arrow.endBinding?.focus ?? 0,
      gap: BIND_GAP,
    };
    const { start, end } = facingEndpoints(frameBox(fromFrame), frameBox(toFrame));
    // Keep user waypoints: Excalidraw/native editing or the waypoint overlay
    // store them as intermediate scene points. Only the two bound ends move.
    const existing = arrowScenePoints(arrow);
    const middle = existing.length > 2 ? existing.slice(1, -1) : [];
    const geometry = arrowGeometryFromPoints([start, ...middle, end]);
    const before = arrow.startBinding ?? {};
    const after = arrow.endBinding ?? {};
    const bindingsChanged =
      before.elementId !== startBinding.elementId ||
      after.elementId !== endBinding.elementId ||
      (before.gap ?? BIND_GAP) !== startBinding.gap ||
      (after.gap ?? BIND_GAP) !== endBinding.gap;
    const points = Array.isArray(arrow.points) ? arrow.points : null;
    const geometryChanged =
      !near(arrow.x, geometry.x) ||
      !near(arrow.y, geometry.y) ||
      !near(arrow.width, geometry.width) ||
      !near(arrow.height, geometry.height) ||
      !points ||
      points.length !== geometry.points.length ||
      points.some(
        (point, index) =>
          !near(point[0], geometry.points[index][0]) || !near(point[1], geometry.points[index][1]),
      );
    if (!bindingsChanged && !geometryChanged) continue;
    changed = true;
    setElement(bumpElement(arrow, { ...geometry, startBinding, endBinding }));
  }

  const bound = out.filter(isRelationArrow);
  for (const gridId of gridIds) {
    const frame = frameOf(gridId);
    if (!frame) continue;
    const arrows = bound
      .filter((arrow) => {
        const rel = arrow.customData.relation;
        return rel.fromGrid === gridId || rel.toGrid === gridId;
      })
      .map((arrow) => ({ id: arrow.id, type: "arrow" }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    // Remove only relation arrows owned by this frame. A user-drawn arrow that
    // happens to bind to the frame must keep its back-reference.
    const relationIds = new Set(arrows.map((entry) => entry.id));
    const keep = (frame.boundElements || []).filter(
      (entry) => entry?.type !== "arrow" || !relationIds.has(entry.id),
    );
    const nextBound = [...keep, ...arrows];
    const value = nextBound.length ? nextBound : null;
    if (JSON.stringify(frame.boundElements ?? null) === JSON.stringify(value)) continue;
    changed = true;
    setElement(bumpElement(frame, { boundElements: value }));
  }

  return changed ? out : null;
}

/**
 * Set both arrowheads of one relation to a preset. Returns a new element array,
 * or null when the arrow/preset is missing or the heads already match.
 */
export function applyCardinalityToElements(elements, arrowId, presetId) {
  const preset = RELATION_PRESETS.find((p) => p.id === presetId);
  if (!preset) return null;
  const list = Array.isArray(elements) ? elements : [];
  const arrow = list.find((el) => el.id === arrowId && el.type === "arrow" && !el.isDeleted);
  if (!arrow) return null;
  if (arrow.startArrowhead === preset.start && arrow.endArrowhead === preset.end) return null;
  return list.map((el) =>
    el === arrow ? bumpElement(el, { startArrowhead: preset.start, endArrowhead: preset.end }) : el,
  );
}
