#!/usr/bin/env node
/**
 * scripts/test-merge.mjs — unit tests for merging and splitting table cells.
 *
 * Pure geometry, no browser and no server:
 *
 *   node scripts/test-merge.mjs
 */

import assert from "node:assert/strict";
import {
  attachCellText,
  buildGrid,
  cellSpan,
  gridMetrics,
  isGridCell,
  mergeGridRange,
  resizeGridColumn,
  splitGridCell,
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
const gridId = page.filter((el) => isGridCell(el))[0].customData.grid;

const cellsOf = (elements) => elements.filter((el) => isGridCell(el, gridId));
const cellAt = (elements, r, c) => cellsOf(elements).find((el) => el.customData.r === r && el.customData.c === c);

/** The scene plus "alpha" in 0:0 and "beta" in 0:1, so text moves can be observed. */
function withTexts() {
  const els = [...page];
  const a = cellAt(els, 0, 0);
  const b = cellAt(els, 0, 1);
  els.push(attachCellText(a, "alpha", { groupIds: a.groupIds ?? [], customData: { grid: gridId, r: 0, c: 0 }, id: `${a.id}-t` }));
  els.push(attachCellText(b, "beta", { groupIds: b.groupIds ?? [], customData: { grid: gridId, r: 0, c: 1 }, id: `${b.id}-t` }));
  return els;
}

const textOf = (elements, cellId) =>
  elements.find((el) => el.type === "text" && el.containerId === cellId)?.text ?? null;

const widthsOf = (elements) => gridMetrics(elements, gridId).cols.map((col) => Math.round(col.width));
const heightsOf = (elements) => gridMetrics(elements, gridId).rows.map((row) => Math.round(row.height));

check("a fresh grid has no merged cells", () => {
  assert.equal(cellsOf(page).length, 12);
  for (const cell of cellsOf(page)) {
    const span = cellSpan(cell);
    assert.equal(span.rowSpan, 1);
    assert.equal(span.colSpan, 1);
  }
});

const before = { cols: widthsOf(page), rows: heightsOf(page), bounds: gridMetrics(page, gridId).bounds };

check("merging two cells side by side keeps one element", () => {
  const merged = mergeGridRange(withTexts(), gridId, { r0: 0, c0: 0, r1: 0, c1: 1 });
  assert.equal(merged.changed, 1, "merge reported no change");
  const cells = cellsOf(merged.elements);
  assert.equal(cells.length, 11, `expected 11 cells, got ${cells.length}`);
  const span = cellSpan(cells[0]);
  assert.equal(span.colSpan, 2);
  assert.equal(span.rowSpan, 1);
});

check("the merged cell covers both columns and nothing else moves", () => {
  const merged = mergeGridRange(page, gridId, { r0: 0, c0: 0, r1: 0, c1: 1 });
  const metrics = gridMetrics(merged.elements, gridId);
  assert.deepEqual(metrics.cols.map((col) => Math.round(col.width)), before.cols, "column widths changed");
  assert.deepEqual(metrics.rows.map((row) => Math.round(row.height)), before.rows, "row heights changed");
  assert.equal(Math.round(metrics.bounds.width), Math.round(before.bounds.width));
  const cell = cellAt(merged.elements, 0, 0);
  assert.ok(Math.abs(cell.width - (before.cols[0] + before.cols[1])) <= 1, `merged width is ${cell.width}`);
  assert.ok(Math.abs(cell.height - before.rows[0]) <= 1, `merged height is ${cell.height}`);
});

check("the top-left text survives and the swallowed text goes", () => {
  const els = withTexts();
  const top = cellAt(els, 0, 0);
  const swallowed = cellAt(els, 0, 1);
  const merged = mergeGridRange(els, gridId, { r0: 0, c0: 0, r1: 0, c1: 1 });
  assert.equal(textOf(merged.elements, top.id), "alpha");
  assert.equal(textOf(merged.elements, swallowed.id), null, "the hidden cell's text is still there");
  assert.equal(merged.elements.filter((el) => el.type === "text").length, 1);
});

check("splitting puts the plain cells back", () => {
  const merged = mergeGridRange(page, gridId, { r0: 0, c0: 0, r1: 0, c1: 1 });
  const mergedCell = cellAt(merged.elements, 0, 0);
  const split = splitGridCell(merged.elements, gridId, mergedCell.id);
  assert.equal(split.changed, 1, "split reported no change");
  const cells = cellsOf(split.elements);
  assert.equal(cells.length, 12, `expected 12 cells, got ${cells.length}`);
  for (const cell of cells) {
    const span = cellSpan(cell);
    assert.equal(span.rowSpan, 1);
    assert.equal(span.colSpan, 1);
  }
  assert.deepEqual(widthsOf(split.elements), before.cols, "column widths changed");
  assert.deepEqual(heightsOf(split.elements), before.rows, "row heights changed");
});

check("splitting keeps the text in its cell", () => {
  const els = withTexts();
  const top = cellAt(els, 0, 0);
  const merged = mergeGridRange(els, gridId, { r0: 0, c0: 0, r1: 0, c1: 1 });
  const split = splitGridCell(merged.elements, gridId, top.id);
  assert.equal(textOf(split.elements, top.id), "alpha");
  const back = cellAt(split.elements, 0, 1);
  assert.ok(back, "the second cell did not come back");
  assert.equal(textOf(split.elements, back.id), null);
});

check("merging a whole row is refused (the row would lose its only witness)", () => {
  const result = mergeGridRange(page, gridId, { r0: 0, c0: 0, r1: 0, c1: 2 });
  assert.equal(result.changed, 0);
  assert.equal(result.reason, "row");
});

check("a ragged selection is refused", () => {
  const result = mergeGridRange(page, gridId, { r0: 0, c0: 0, r1: 1, c1: 1 });
  assert.equal(result.changed, 1, "a full 2x2 rectangle should merge");
  const ragged = mergeGridRange(page, gridId, { r0: 2, c0: 0, r1: 3, c1: 1 });
  assert.equal(ragged.changed, 1, "a full 2x2 rectangle should merge");
});

check("a single cell is not a merge", () => {
  const result = mergeGridRange(page, gridId, { r0: 1, c0: 1, r1: 1, c1: 1 });
  assert.equal(result.changed, 0);
  assert.equal(result.reason, "single");
});

check("a merged cell grows with its column when the border is dragged", () => {
  const merged = mergeGridRange(page, gridId, { r0: 0, c0: 0, r1: 0, c1: 1 });
  const cell = cellAt(merged.elements, 0, 0);
  const resized = resizeGridColumn(merged.elements, gridId, 0, before.cols[0] + 40);
  assert.equal(resized.changed > 0, true, "resize changed nothing");
  const grown = cellAt(resized.elements, 0, 0);
  assert.ok(grown, "the merged cell vanished");
  assert.ok(
    Math.abs(grown.width - (cell.width + 40)) <= 1,
    `merged width ${cell.width} -> ${grown.width}, expected +40`,
  );
  const metrics = gridMetrics(resized.elements, gridId);
  assert.ok(Math.abs(metrics.cols[0].width - (before.cols[0] + 40)) <= 1);
});

check("a merged cell in the last column keeps the tiling", () => {
  const merged = mergeGridRange(page, gridId, { r0: 1, c0: 1, r1: 2, c1: 1 });
  assert.equal(merged.changed, 1);
  const cells = cellsOf(merged.elements);
  assert.equal(cells.length, 11);
  const metrics = gridMetrics(merged.elements, gridId);
  assert.deepEqual(metrics.cols.map((col) => Math.round(col.width)), before.cols);
  assert.deepEqual(metrics.rows.map((row) => Math.round(row.height)), before.rows);
});

console.log(`\n${passed}/${passed + fails.length} checks passed`);
if (fails.length) {
  console.log("\nFailures:");
  for (const name of fails) console.log(`- ${name}`);
  process.exitCode = 1;
}
