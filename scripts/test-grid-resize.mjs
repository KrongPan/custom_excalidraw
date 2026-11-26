#!/usr/bin/env node
/**
 * scripts/test-grid-resize.mjs — unit tests for the table row/column sizing helpers.
 *
 * Runs the pure geometry helpers in app/src/table.js against a freshly built
 * grid, so it needs no browser, no server and no network:
 *
 *   node scripts/test-grid-resize.mjs
 */

import assert from "node:assert/strict";
import {
  attachCellText,
  buildGrid,
  gridMetrics,
  isGridCell,
  isGridFrame,
  matchSizes,
  resizeGridColumn,
  resizeGridRow,
} from "../app/src/table.js";

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

const built = buildGrid({ columns: 3, rows: 4, width: 580, height: 300, color: "blue", headerRow: true });
const page = built.elements;
// isGridCell skips the transparent table frame (customData.frame), which is also
// a rectangle; a plain type check would count 13 rectangles for a 3x4 table
const cells = page.filter((el) => isGridCell(el));
const frames = page.filter((el) => isGridFrame(el));
const gridId = cells[0].customData.grid;

check("buildGrid makes one rectangle per cell and no text yet", () => {
  assert.equal(cells.length, 12);
  assert.equal(frames.length, 1, `frames ${frames.length}`);
  assert.equal(frames[0].id, `${gridId}-frame`);
  assert.equal(page.filter((el) => el.type === "text").length, 0);
});

check("uniform grid splits evenly", () => {
  const metrics = gridMetrics(page, gridId);
  assert.equal(metrics.rows.length, 4);
  assert.equal(metrics.cols.length, 3);
  const heights = metrics.rows.map((row) => Math.round(row.height));
  const widths = metrics.cols.map((col) => Math.round(col.width));
  assert.deepEqual(new Set(heights).size, 1, `row heights ${heights}`);
  assert.deepEqual(new Set(widths).size, 1, `column widths ${widths}`);
  assert.equal(Math.round(metrics.bounds.height), 300);
});

check("resizeGridRow grows only the named row and pushes the rest down", () => {
  const before = gridMetrics(page, gridId);
  const { elements, changed } = resizeGridRow(page, gridId, 1, before.rows[1].height + 20);
  const after = gridMetrics(elements, gridId);
  assert.ok(changed >= 3, `changed ${changed}`);
  assert.equal(Math.round(after.rows[0].height), Math.round(before.rows[0].height));
  assert.equal(Math.round(after.rows[1].height), Math.round(before.rows[1].height) + 20);
  assert.equal(Math.round(after.rows[2].height), Math.round(before.rows[2].height));
  assert.equal(Math.round(after.rows[2].top), Math.round(before.rows[2].top) + 20);
  assert.equal(Math.round(after.cols[1].width), Math.round(before.cols[1].width));
});

check("resizeGridRow keeps bound text centred in the taller cell", () => {
  const target = cells.find((el) => el.customData.r === 1 && el.customData.c === 1);
  const withText = [
    ...page,
    attachCellText(target, "hello", { groupIds: target.groupIds, customData: target.customData }),
  ];
  const before = gridMetrics(withText, gridId);
  const { elements } = resizeGridRow(withText, gridId, 1, before.rows[1].height + 20);
  const cell = elements.find(
    (el) => el.type === "rectangle" && el.customData.r === 1 && el.customData.c === 1,
  );
  const text = elements.find((el) => el.type === "text" && el.containerId === cell.id);
  assert.ok(text, "bound text survived the resize");
  const centre = cell.y + cell.height / 2;
  const textCentre = text.y + text.height / 2;
  assert.ok(Math.abs(centre - textCentre) <= 1.5, `cell ${centre} vs text ${textCentre}`);
});

check("resizeGridColumn grows only the named column and shifts the rest right", () => {
  const before = gridMetrics(page, gridId);
  const { elements } = resizeGridColumn(page, gridId, 0, before.cols[0].width + 40);
  const after = gridMetrics(elements, gridId);
  assert.equal(Math.round(after.cols[0].width), Math.round(before.cols[0].width) + 40);
  assert.equal(Math.round(after.cols[1].width), Math.round(before.cols[1].width));
  assert.equal(Math.round(after.cols[1].left), Math.round(before.cols[1].left) + 40);
  assert.equal(Math.round(after.rows[1].height), Math.round(before.rows[1].height));
});

check("repeated +10 resizes never drift the grid", () => {
  let current = page;
  const before = gridMetrics(page, gridId);
  for (let i = 0; i < 5; i += 1) {
    const metrics = gridMetrics(current, gridId);
    current = resizeGridColumn(current, gridId, 0, metrics.cols[0].width + 10).elements;
  }
  const after = gridMetrics(current, gridId);
  assert.equal(Math.round(after.cols[0].width), Math.round(before.cols[0].width) + 50);
  assert.equal(Math.round(after.cols[2].left), Math.round(before.cols[2].left) + 50);
  assert.equal(Math.round(after.bounds.right), Math.round(before.bounds.right) + 50);
});

check("sizes clamp to the allowed range", () => {
  const tiny = resizeGridRow(page, gridId, 0, 1).elements;
  const huge = resizeGridColumn(page, gridId, 0, 999999).elements;
  assert.equal(Math.round(gridMetrics(tiny, gridId).rows[0].height), 24);
  assert.equal(Math.round(gridMetrics(huge, gridId).cols[0].width), 1600);
});

check("a resize to the current size changes nothing", () => {
  const before = gridMetrics(page, gridId);
  const result = resizeGridRow(page, gridId, 2, before.rows[2].height);
  assert.equal(result.changed, 0);
  assert.equal(result.elements, page);
});

check("matchSizes pads and trims a size list to the new count", () => {
  assert.deepEqual(matchSizes([100, 120], 4), [100, 120, 110, 110]);
  assert.deepEqual(matchSizes([100, 120, 80], 2), [100, 120]);
  assert.deepEqual(matchSizes(null, 3), []);
});

check("custom column widths survive a rebuild", () => {
  const metrics = gridMetrics(page, gridId);
  const colWidths = metrics.cols.map((col) => Math.round(col.width));
  colWidths[0] = 260;
  colWidths[1] = 160;
  colWidths[2] = 160;
  const rebuilt = buildGrid({
    columns: 3,
    rows: 4,
    width: 580,
    height: 300,
    color: "blue",
    headerRow: true,
    colWidths,
  });
  const rebuiltElements = rebuilt.elements;
  const rebuiltCell = rebuiltElements.find((el) => isGridCell(el));
  assert.ok(rebuiltCell, "rebuilt grid has a cell");
  const after = gridMetrics(rebuiltElements, rebuiltCell.customData.grid);
  assert.ok(Math.abs(after.cols[0].width - 260) <= 2, `column 0 is ${after.cols[0].width}`);
  assert.equal(Math.round(after.bounds.width), 580);
  assert.equal(rebuiltElements.filter((el) => isGridFrame(el)).length, 1, "rebuilt grid has exactly one frame");
});

console.log(`\n${passed}/${passed + fails.length} checks passed`);
if (fails.length) {
  console.log("\nFailures:");
  for (const name of fails) console.log(`- ${name}`);
  process.exitCode = 1;
}
