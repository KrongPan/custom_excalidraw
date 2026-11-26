#!/usr/bin/env node
/**
 * scripts/test-relations.mjs — pure tests for the ER relation helpers.
 *
 *   node scripts/test-relations.mjs
 */

import assert from "node:assert/strict";
import { buildClass } from "../app/src/class.js";
import { isGridCell, isGridFrame, tableBounds } from "../app/src/table.js";
import {
  RELATION_PRESETS,
  applyCardinalityToElements,
  arrowScenePoints,
  cloneAndConnect,
  describeRelation,
  setArrowScenePoints,
  syncRelations,
} from "../app/src/relations.js";

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

const frameOf = (elements, gridId) => elements.find((el) => isGridFrame(el, gridId));
const endPoint = (arrow) => ({
  x: arrow.x + arrow.points[1][0],
  y: arrow.y + arrow.points[1][1],
});

/* ------------------------------------------------------------- source class */

const source = buildClass({
  title: "Order",
  fields: ["+ id: uuid", "+ total: money"],
  methods: ["+ submit(): void"],
  width: 360,
});
const sourceId = source.gridId;
const sourceFrame = frameOf(source.elements, sourceId);
const sourceBounds = tableBounds(source.elements, sourceId);

check("buildClass produces a frame and class metadata", () => {
  assert.ok(sourceFrame);
  assert.equal(sourceFrame.customData.class, true);
  assert.equal(sourceFrame.customData.classData.title, "Order");
  assert.deepEqual(sourceFrame.customData.classData.fields, ["+ id: uuid", "+ total: money"]);
  assert.deepEqual(sourceFrame.customData.classData.methods, ["+ submit(): void"]);
  assert.equal(source.elements.filter((el) => isGridCell(el)).length, 0);
});

check("tableBounds falls back to the class frame", () => {
  assert.ok(sourceBounds);
  assert.equal(sourceBounds.left, sourceFrame.x);
  assert.equal(sourceBounds.top, sourceFrame.y);
  assert.equal(sourceBounds.width, sourceFrame.width);
  assert.equal(sourceBounds.height, sourceFrame.height);
});

/* ---------------------------------------------------------------- clone+link */

const result = cloneAndConnect(source.elements, sourceId, "right");
const cloneId = result.cloneGridId;
const sourceFrameAfter = frameOf(result.elements, sourceId);
const cloneFrame = frameOf(result.elements, cloneId);
const arrow = result.elements.find((el) => el.id === result.arrowId);

check("cloneAndConnect copies the class fields, methods and title", () => {
  assert.ok(cloneId && cloneId !== sourceId);
  assert.ok(sourceFrameAfter && cloneFrame);
  assert.equal(cloneFrame.customData.class, true);
  assert.equal(cloneFrame.customData.classData.title, "Order");
  assert.deepEqual(cloneFrame.customData.classData.fields, ["+ id: uuid", "+ total: money"]);
  assert.deepEqual(cloneFrame.customData.classData.methods, ["+ submit(): void"]);
  assert.equal(result.elements.filter((el) => isGridCell(el, cloneId)).length, 0);
  assert.equal(result.selectedId, cloneFrame.id);
});

check("clone is placed to the right of the source", () => {
  assert.ok(cloneFrame.x >= sourceBounds.right + 140 - 0.5, `${cloneFrame.x}`);
  const sourceCentre = sourceFrame.y + sourceFrame.height / 2;
  const cloneCentre = cloneFrame.y + cloneFrame.height / 2;
  assert.ok(Math.abs(sourceCentre - cloneCentre) <= 0.5, `${sourceCentre} vs ${cloneCentre}`);
});

check("one arrow binds both class frames with 1:1 crowfoot heads", () => {
  assert.ok(arrow);
  assert.equal(arrow.type, "arrow");
  assert.equal(arrow.startBinding.elementId, sourceFrameAfter.id);
  assert.equal(arrow.endBinding.elementId, cloneFrame.id);
  assert.equal(arrow.startArrowhead, "crowfoot_one");
  assert.equal(arrow.endArrowhead, "crowfoot_one");
  assert.equal(arrow.elbowed, false);
  assert.deepEqual(arrow.customData.relation, { fromGrid: sourceId, toGrid: cloneId });
  assert.ok(sourceFrameAfter.boundElements?.some((entry) => entry.id === arrow.id));
  assert.ok(cloneFrame.boundElements?.some((entry) => entry.id === arrow.id));
});

/* ------------------------------------------------------------------ route */

check("waypoints survive sync and only the bound ends follow the class frames", () => {
  const endpoints = arrowScenePoints(arrow);
  assert.equal(endpoints.length, 2);
  const bend = { x: (endpoints[0].x + endpoints[1].x) / 2, y: endpoints[0].y - 80 };
  const routed = setArrowScenePoints(result.elements, result.arrowId, [
    endpoints[0],
    bend,
    endpoints[1],
  ]);
  assert.ok(routed);
  assert.equal(routed.find((el) => el.id === result.arrowId).points.length, 3);
  assert.equal(syncRelations(routed), null, "a consistent route must not change");

  const moved = routed.map((el) =>
    el.customData?.grid === cloneId ? { ...el, x: el.x + 300 } : el,
  );
  const rerouted = syncRelations(moved);
  assert.ok(rerouted, "syncRelations dropped a class relation with waypoints");
  const movedPoints = arrowScenePoints(rerouted.find((el) => el.id === result.arrowId));
  assert.equal(movedPoints.length, 3);
  assert.ok(Math.abs(movedPoints[1].x - bend.x) < 0.5, "waypoint moved with the clone");
  assert.ok(Math.abs(movedPoints[1].y - bend.y) < 0.5, "waypoint changed vertically");
  assert.ok(Math.abs(movedPoints[2].x - (endpoints[1].x + 300)) < 0.5, "bound end did not follow");
});

check("removing the bend goes back to a straight arrow", () => {
  const endpoints = arrowScenePoints(arrow);
  const straight = setArrowScenePoints(result.elements, result.arrowId, endpoints);
  assert.equal(syncRelations(straight), null);
  assert.equal(straight.find((el) => el.id === result.arrowId).points.length, 2);
});

/* -------------------------------------------------------------- resilience */

check("a deleted clone frame is revived under the same id, never duplicated", () => {
  const deleted = result.elements.map((el) =>
    el.id === cloneFrame.id ? { ...el, isDeleted: true } : el,
  );
  const revived = syncRelations(deleted);
  assert.ok(revived);
  const liveFrames = revived.filter((el) => isGridFrame(el, cloneId));
  assert.equal(liveFrames.length, 1);
  assert.equal(liveFrames[0].id, `${cloneId}-frame`);
  assert.equal(liveFrames[0].isDeleted, false);
  assert.equal(
    revived.filter((el) => el.id === `${cloneId}-frame`).length,
    1,
    "duplicate frame id",
  );
  assert.equal(
    revived.find((el) => el.id === result.arrowId).endBinding.elementId,
    liveFrames[0].id,
  );
});

check("cardinality presets set both native crowfoot heads", () => {
  assert.equal(RELATION_PRESETS.length, 4);
  assert.equal(describeRelation(arrow).preset, "one-one");
  const many = applyCardinalityToElements(result.elements, result.arrowId, "many-many");
  assert.ok(many);
  const manyArrow = many.find((el) => el.id === result.arrowId);
  assert.equal(manyArrow.startArrowhead, "crowfoot_many");
  assert.equal(manyArrow.endArrowhead, "crowfoot_many");
  assert.equal(describeRelation(manyArrow).preset, "many-many");
  assert.equal(applyCardinalityToElements(many, result.arrowId, "many-many"), null);
});

check("class frames and grid cells stay disjoint", () => {
  assert.equal(isGridCell(sourceFrame), false);
  assert.equal(isGridCell(cloneFrame), false);
  assert.equal(isGridFrame(cloneFrame), true);
});

console.log(`\n${passed}/${passed + fails.length} checks passed`);
if (fails.length) {
  console.log("\nFailures:");
  for (const name of fails) console.log(`- ${name}`);
  process.exit(1);
}
