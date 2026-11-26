#!/usr/bin/env node
/**
 * scripts/test-class.mjs — pure tests for the UML class preset.
 *
 *   node scripts/test-class.mjs
 */

import assert from "node:assert/strict";
import {
  buildClass,
  describeClass,
  healClass,
  isClassGrid,
  readClassSpec,
  toggleClass,
  updateClass,
} from "../app/src/class.js";
import { isGridCell, isGridFrame, tableBounds } from "../app/src/table.js";

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

const built = buildClass({
  title: "Classname",
  fields: ["+ field: type", "+ field: two", "+ field: three"],
  methods: ["+ method(type): type"],
  width: 360,
});
const page = built.elements;
const gridId = built.gridId;
const frame = page.find((el) => isGridFrame(el, gridId));
const fieldTexts = page.filter((el) => el.customData?.classLine === "fields");
const methodTexts = page.filter((el) => el.customData?.classLine === "methods");

check("buildClass creates a visible frame with title, sections and toggle", () => {
  assert.ok(frame, "frame missing");
  assert.equal(page[0].id, frame.id, "frame is not first");
  assert.equal(frame.customData.class, true);
  assert.equal(frame.customData.classData.fields.length, 3);
  assert.equal(frame.customData.classData.methods.length, 1);
  assert.ok(frame.strokeColor !== "transparent" && frame.backgroundColor !== "transparent");
  assert.equal(fieldTexts.length, 3);
  assert.equal(methodTexts.length, 1);
  assert.equal(page.filter((el) => el.type === "line" && el.customData?.grid === gridId).length, 2);
  assert.equal(page.filter((el) => el.customData?.classToggle).length, 2);
  assert.equal(page.filter((el) => el.customData?.classTitle).length, 1);
  assert.equal(page.filter((el) => isGridCell(el)).length, 0);
  assert.equal(isClassGrid(page, gridId), true);
});

check("tableBounds falls back to the class frame", () => {
  const bounds = tableBounds(page, gridId);
  assert.ok(bounds);
  assert.equal(bounds.left, frame.x);
  assert.equal(bounds.top, frame.y);
  assert.equal(bounds.width, frame.width);
  assert.equal(bounds.height, frame.height);
});

check("describeClass reads title, fields, methods and width", () => {
  const spec = describeClass(page, gridId);
  assert.equal(spec.kind, "class");
  assert.equal(spec.title, "Classname");
  assert.deepEqual(spec.fields, ["+ field: type", "+ field: two", "+ field: three"]);
  assert.deepEqual(spec.methods, ["+ method(type): type"]);
  assert.equal(spec.width, 360);
  assert.equal(spec.collapsed, false);
});

check("collapse hides sections but keeps their data, expand restores them", () => {
  const collapsed = toggleClass(page, gridId);
  assert.ok(collapsed, "toggleClass returned null");
  const cFrame = collapsed.elements.find((el) => isGridFrame(el, gridId));
  assert.equal(cFrame.height, 44);
  assert.equal(collapsed.elements.filter((el) => el.customData?.classLine).length, 0);
  assert.deepEqual(cFrame.customData.classData.fields, ["+ field: type", "+ field: two", "+ field: three"]);
  const cSpec = describeClass(collapsed.elements, gridId);
  assert.equal(cSpec.collapsed, true);
  assert.deepEqual(cSpec.fields, ["+ field: type", "+ field: two", "+ field: three"]);

  const expanded = toggleClass(collapsed.elements, gridId);
  assert.ok(expanded, "re-expand returned null");
  const eSpec = describeClass(expanded.elements, gridId);
  assert.equal(eSpec.collapsed, false);
  assert.deepEqual(eSpec.fields, ["+ field: type", "+ field: two", "+ field: three"]);
  assert.equal(expanded.elements.filter((el) => el.customData?.classLine === "fields").length, 3);
});

check("updateClass keeps the node position and replaces its content", () => {
  const shifted = page.map((el) => ({ ...el, x: el.x + 100, y: el.y + 50 }));
  const next = updateClass(shifted, gridId, {
    title: "Order",
    fields: ["+ id: uuid"],
    methods: [],
  });
  assert.ok(next, "updateClass returned null");
  const nFrame = next.elements.find((el) => isGridFrame(el, gridId));
  assert.equal(nFrame.x, 100);
  assert.equal(nFrame.y, 50);
  const spec = describeClass(next.elements, gridId);
  assert.equal(spec.title, "Order");
  assert.deepEqual(spec.fields, ["+ id: uuid"]);
  assert.deepEqual(spec.methods, []);
});

check("healClass reflows an edited line and is idempotent", () => {
  const edited = page.map((el) =>
    el.customData?.classLine === "fields" && el.customData.index === 0
      ? { ...el, text: "a much longer field that must fit", originalText: "a much longer field that must fit", width: 900, height: 80 }
      : el,
  );
  const healed = healClass(edited, gridId);
  assert.ok(healed, "healClass returned null after a real text edit");
  const line = healed.find(
    (el) => el.customData?.classLine === "fields" && el.customData.index === 0,
  );
  assert.equal(line.text, "a much longer field that must fit");
  assert.ok(line.x === 16, `line x ${line.x}`);
  assert.ok(line.width <= 360 - 32 + 0.5, `line width ${line.width}`);
  assert.ok(line.fontSize <= 13, `line fontSize ${line.fontSize}`);
  const frameAfter = healed.find((el) => isGridFrame(el, gridId));
  assert.equal(frameAfter.customData.classData.fields[0], "a much longer field that must fit");
  assert.equal(healClass(healed, gridId), null, "healClass is not idempotent");
});

check("collapsed frame heals back to the header height", () => {
  const collapsed = toggleClass(page, gridId).elements;
  const tall = collapsed.map((el) =>
    el.id === frame.id ? { ...el, height: 333 } : el,
  );
  const healed = healClass(tall, gridId);
  assert.ok(healed, "collapsed frame was not healed");
  const hFrame = healed.find((el) => isGridFrame(el, gridId));
  assert.equal(hFrame.height, 44);
  assert.equal(hFrame.customData.classData.collapsed, true);
  assert.equal(healClass(healed, gridId), null);
});

console.log(`\n${passed}/${passed + fails.length} checks passed`);
if (fails.length) {
  console.log("\nFailures:");
  for (const name of fails) console.log(`- ${name}`);
  process.exit(1);
}
