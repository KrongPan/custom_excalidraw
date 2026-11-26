#!/usr/bin/env node
/**
 * scripts/test-relations.mjs — pure tests for the table relation helpers.
 *
 * No browser, no server and no network: builds real grids with table.js and
 * drives cloneAndConnect / syncRelations / applyCardinalityToElements directly.
 *
 *   node scripts/test-relations.mjs
 */

import assert from "node:assert/strict";
import {
  attachCellText,
  buildGrid,
  gridMetrics,
  healGrid,
  isGridCell,
  isGridFrame,
  resizeGridRow,
  tableBounds,
} from "../app/src/table.js";
import {
  RELATION_PRESETS,
  applyCardinalityToElements,
  arrowScenePoints,
  cloneAndConnect,
  describeRelation,
  setArrowScenePoints,
  syncRelations,
} from "../app/src/relations.js";
import { buildClass } from "../app/src/class.js";

const fails = [];
let passed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (error) {
    fails.push(name);
    console.log(`FAIL  ${name} — ${error.message}`);
  }
}

const cellsOf = (elements, gridId) => elements.filter((el) => isGridCell(el, gridId));
const frameOf = (elements, gridId) => elements.find((el) => isGridFrame(el, gridId));
const textInCell = (elements, cellId) =>
  elements.find((el) => el.type === "text" && !el.isDeleted && el.containerId === cellId);
const endPoint = (arrow) => ({
  x: arrow.x + arrow.points[1][0],
  y: arrow.y + arrow.points[1][1],
});

/* ------------------------------------------------------------- source table */

const built = buildGrid({
  columns: 3,
  rows: 4,
  width: 900,
  height: 400,
  color: "blue",
  headerRow: true,
  title: "orders",
});
const source = built.elements;
const sourceGridId = source.find((el) => isGridCell(el)).customData.grid;
const sourceCells = cellsOf(source, sourceGridId);
const sourceTitle = source.find((el) => el.type === "text" && el.customData?.title);
const sourceBody = gridMetrics(source, sourceGridId);
const sourceBounds = tableBounds(source, sourceGridId);

// one cell carries text: the clone must not copy it
const sourceCell = sourceCells.find((el) => el.customData.r === 1 && el.customData.c === 1);
const sourceText = attachCellText(sourceCell, "invoice", {
  groupIds: sourceCell.groupIds,
  customData: { grid: sourceGridId, r: 1, c: 1 },
  id: `${sourceCell.id}-t`,
});
source.push(sourceText);

check("buildGrid puts one transparent frame first and keeps cells separate", () => {
  assert.equal(isGridFrame(source[0]), true);
  assert.equal(source.filter((el) => isGridFrame(el)).length, 1);
  assert.equal(isGridCell(source[0]), false);
  assert.equal(sourceCells.length, 12);
  assert.equal(frameOf(source, sourceGridId).id, `${sourceGridId}-frame`);
});

check("tableBounds covers the title and body, never the frame", () => {
  assert.ok(sourceTitle, "source title missing");
  assert.equal(Math.round(sourceBounds.width), 900);
  assert.ok(sourceBounds.height > sourceBody.bounds.height, "title height not included");
  assert.equal(Math.round(sourceBounds.top), Math.round(sourceTitle.y));
  assert.ok(sourceBounds.bottom >= sourceBody.bounds.bottom - 0.5);
});

check("frame follows a row resize through healGrid", () => {
  const before = frameOf(source, sourceGridId);
  const row = sourceBody.rows[1];
  const resized = resizeGridRow(source, sourceGridId, 1, row.height + 24).elements;
  const healed = healGrid(resized, sourceGridId);
  assert.ok(healed, "healGrid returned null after a real resize");
  const after = frameOf(healed, sourceGridId);
  const bounds = tableBounds(healed, sourceGridId);
  assert.ok(after.height >= before.height + 23, `${before.height} -> ${after.height}`);
  assert.ok(Math.abs(after.x - bounds.left) < 0.5 && Math.abs(after.y - bounds.top) < 0.5);
  assert.ok(Math.abs(after.width - bounds.width) < 0.5 && Math.abs(after.height - bounds.height) < 0.5);
});

/* ---------------------------------------------------------------- clone+link */

const result = cloneAndConnect(source, sourceGridId, "right");
const cloneGridId = result.cloneGridId;
const cloneCells = cellsOf(result.elements, cloneGridId);
const cloneMetrics = gridMetrics(result.elements, cloneGridId);
const sourceFrame = frameOf(result.elements, sourceGridId);
const cloneFrame = frameOf(result.elements, cloneGridId);
const arrow = result.elements.find((el) => el.id === result.arrowId);

check("cloneAndConnect clones the structure without the cell text", () => {
  assert.ok(cloneGridId && cloneGridId !== sourceGridId);
  assert.equal(cloneCells.length, 12);
  assert.equal(sourceCells[0].customData.color, cloneCells[0].customData.color);
  assert.equal(sourceCells[0].customData.headerRow, cloneCells[0].customData.headerRow);
  assert.equal(cloneCells[0].customData.rows, 4);
  assert.equal(cloneCells[0].customData.cols, 3);
  assert.equal(textInCell(result.elements, sourceCell.id)?.text, "invoice");
  for (const cell of cloneCells) {
    assert.equal(textInCell(result.elements, cell.id), undefined, `clone cell ${cell.id} carries text`);
  }
  const cloneTitle = result.elements.find(
    (el) => el.type === "text" && el.customData?.grid === cloneGridId && el.customData?.title,
  );
  assert.equal(cloneTitle?.text, "orders");
});

check("clone keeps a resized body (900x400), not buildGrid defaults", () => {
  assert.equal(Math.round(cloneMetrics.bounds.width), 900);
  assert.equal(Math.round(cloneMetrics.bounds.height), 400);
  assert.deepEqual(
    cloneMetrics.rows.map((row) => Math.round(row.height)),
    sourceBody.rows.map((row) => Math.round(row.height)),
  );
  assert.deepEqual(
    cloneMetrics.cols.map((col) => Math.round(col.width)),
    sourceBody.cols.map((col) => Math.round(col.width)),
  );
  assert.ok(cloneFrame, "clone frame missing");
  assert.equal(cloneFrame.id, `${cloneGridId}-frame`);
  assert.ok(cloneFrame.height > cloneMetrics.bounds.height, "clone frame must include the title");
  assert.ok(cloneFrame.width >= cloneMetrics.bounds.width, "clone frame must cover the body");
});

check("clone is placed 140px to the right, centre aligned", () => {
  assert.ok(cloneFrame.x >= sourceBounds.right + 140 - 0.5, `clone x ${cloneFrame.x}`);
  const sourceCentre = sourceFrame.y + sourceFrame.height / 2;
  const cloneCentre = cloneFrame.y + cloneFrame.height / 2;
  assert.ok(Math.abs(sourceCentre - cloneCentre) <= 0.5, `${sourceCentre} vs ${cloneCentre}`);
  assert.equal(result.selectedId, cloneFrame.id);
});

check("one bound relation arrow joins the two frames", () => {
  assert.ok(arrow, "relation arrow missing");
  assert.equal(arrow.type, "arrow");
  assert.equal(arrow.startBinding.elementId, sourceFrame.id);
  assert.equal(arrow.endBinding.elementId, cloneFrame.id);
  assert.equal(arrow.startArrowhead, "crowfoot_one");
  assert.equal(arrow.endArrowhead, "crowfoot_one");
  assert.equal(arrow.elbowed, false);
  assert.deepEqual(arrow.customData.relation, {
    fromGrid: sourceGridId,
    toGrid: cloneGridId,
  });
  assert.ok(sourceFrame.boundElements?.some((entry) => entry.id === arrow.id), "source frame not bound");
  assert.ok(cloneFrame.boundElements?.some((entry) => entry.id === arrow.id), "clone frame not bound");
});

check("waypoints survive syncRelations and only endpoints follow the frames", () => {
  const endpoints = arrowScenePoints(arrow);
  assert.equal(endpoints.length, 2);
  const bend = { x: (endpoints[0].x + endpoints[1].x) / 2, y: endpoints[0].y - 80 };
  const routed = setArrowScenePoints(result.elements, result.arrowId, [endpoints[0], bend, endpoints[1]]);
  assert.ok(routed, "setArrowScenePoints returned null");
  const routedArrow = routed.find((el) => el.id === result.arrowId);
  assert.equal(routedArrow.points.length, 3);

  const syncedRoute = syncRelations(routed);
  assert.equal(syncedRoute, null, "an already-consistent waypoint route changed on sync");
  const afterRoute = routedArrow ? arrowScenePoints(routedArrow) : [];
  assert.ok(Math.abs(afterRoute[1].x - bend.x) < 0.5 && Math.abs(afterRoute[1].y - bend.y) < 0.5);

  const moved = routed.map((el) =>
    el.customData?.grid === cloneGridId ? { ...el, x: el.x + 300 } : el,
  );
  const rerouted = syncRelations(moved);
  assert.ok(rerouted, "syncRelations dropped a moved relation with waypoints");
  const movedArrow = arrowScenePoints(rerouted.find((el) => el.id === result.arrowId));
  assert.equal(movedArrow.length, 3);
  assert.ok(Math.abs(movedArrow[1].x - bend.x) < 0.5, "waypoint moved with the clone");
  assert.ok(Math.abs(movedArrow[1].y - bend.y) < 0.5, "waypoint changed vertically");
  assert.ok(Math.abs(movedArrow[2].x - (endpoints[1].x + 300)) < 0.5, "bound end did not follow the clone");

  const straight = setArrowScenePoints(result.elements, result.arrowId, endpoints);
  const twice = syncRelations(straight);
  assert.equal(twice, null);
  assert.equal(straight.find((el) => el.id === result.arrowId).points.length, 2);
});

check("cloneAndConnect clones a UML class as a new empty class", () => {
  const sourceClass = buildClass({
    title: "Order",
    fields: ["+ id: uuid", "+ total: money"],
    methods: ["+ submit(): void"],
    width: 360,
  });
  const cloned = cloneAndConnect(sourceClass.elements, sourceClass.gridId, "right");
  const sourceFrame = cloned.elements.find((el) => isGridFrame(el, sourceClass.gridId));
  const cloneFrame = cloned.elements.find((el) => isGridFrame(el, cloned.cloneGridId));
  assert.ok(sourceFrame && cloneFrame, "class frames missing after clone");
  assert.equal(cloneFrame.customData.class, true);
  assert.deepEqual(cloneFrame.customData.classData.fields, []);
  assert.deepEqual(cloneFrame.customData.classData.methods, []);
  assert.equal(cloneFrame.customData.classData.title, "Order");
  assert.equal(cloned.elements.filter((el) => isGridCell(el, cloned.cloneGridId)).length, 0);
  const arrow = cloned.elements.find((el) => el.id === cloned.arrowId);
  assert.equal(arrow.startBinding.elementId, sourceFrame.id);
  assert.equal(arrow.endBinding.elementId, cloneFrame.id);
  assert.ok(cloneFrame.x >= sourceFrame.x + sourceFrame.width + 139);
});

check("a legacy table gets a frame lazily when first connected", () => {
  const legacy = source.filter((el) => !isGridFrame(el));
  assert.equal(legacy.filter((el) => isGridFrame(el)).length, 0);
  const next = cloneAndConnect(legacy, sourceGridId, "bottom");
  const sourceFrames = next.elements.filter((el) => isGridFrame(el, sourceGridId));
  assert.equal(sourceFrames.length, 1, "source frame not created");
  const firstGridIndex = next.elements.findIndex((el) => el.customData?.grid === sourceGridId);
  assert.equal(next.elements[firstGridIndex].customData.frame, true, "frame is not behind the grid");
  const relationArrow = next.elements.find((el) => el.id === next.arrowId);
  assert.equal(relationArrow.startBinding.elementId, `${sourceGridId}-frame`);
  assert.equal(relationArrow.endBinding.elementId, `${next.cloneGridId}-frame`);
});

check("syncRelations re-routes the arrow when the clone moves", () => {
  const before = endPoint(arrow);
  const moved = result.elements.map((el) =>
    el.customData?.grid === cloneGridId ? { ...el, x: el.x + 300, y: el.y + 40 } : el,
  );
  const synced = syncRelations(moved);
  assert.ok(synced, "syncRelations returned null after a real move");
  const afterArrow = synced.find((el) => el.id === result.arrowId);
  const after = endPoint(afterArrow);
  assert.ok(Math.abs(after.x - before.x - 300) <= 0.5, `end x ${before.x} -> ${after.x}`);
  assert.ok(Math.abs(after.y - before.y - 40) <= 0.5, `end y ${before.y} -> ${after.y}`);
  assert.ok(frameOf(synced, sourceGridId).boundElements?.some((entry) => entry.id === arrow.id));
  assert.equal(syncRelations(synced), null, "second sync must be a no-op");
});

check("a deleted clone frame is revived under the same id, never duplicated", () => {
  const withDeletedFrame = result.elements.map((el) =>
    el.id === cloneFrame.id ? { ...el, isDeleted: true } : el,
  );
  const revived = syncRelations(withDeletedFrame);
  assert.ok(revived, "syncRelations did not revive the frame");
  const liveFrames = revived.filter((el) => isGridFrame(el, cloneGridId));
  assert.equal(liveFrames.length, 1);
  assert.equal(liveFrames[0].id, `${cloneGridId}-frame`);
  assert.equal(liveFrames[0].isDeleted, false);
  assert.equal(
    revived.filter((el) => el.id === `${cloneGridId}-frame`).length,
    1,
    "duplicate frame id",
  );
  const revivedArrow = revived.find((el) => el.id === result.arrowId);
  assert.equal(revivedArrow.endBinding.elementId, liveFrames[0].id);
});

check("cardinality presets set both native crowfoot arrowheads", () => {
  assert.equal(RELATION_PRESETS.length, 4);
  assert.equal(describeRelation(arrow).preset, "one-one");
  const many = applyCardinalityToElements(result.elements, result.arrowId, "many-many");
  assert.ok(many, "cardinality update returned null");
  const manyArrow = many.find((el) => el.id === result.arrowId);
  assert.equal(manyArrow.startArrowhead, "crowfoot_many");
  assert.equal(manyArrow.endArrowhead, "crowfoot_many");
  assert.equal(describeRelation(manyArrow).preset, "many-many");
  assert.equal(applyCardinalityToElements(many, result.arrowId, "many-many"), null);
});

check("frame and cell guards stay disjoint", () => {
  assert.equal(isGridCell(cloneFrame), false);
  assert.equal(isGridFrame(cloneCells[0]), false);
  assert.equal(isGridFrame(frameOf(source, sourceGridId)), true);
});

console.log(`\n${passed}/${passed + fails.length} checks passed`);
if (fails.length) {
  console.log("\nFailures:");
  for (const name of fails) console.log(`- ${name}`);
  process.exit(1);
}
