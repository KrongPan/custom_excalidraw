#!/usr/bin/env node
/**
 * Randomised soak test for the table builder.
 *
 * It drives the real panel in a real (headless) Chrome exactly like a person
 * would — typing numbers, dragging sliders, dragging cells, pressing Cmd+Z —
 * and after *every* operation it checks the invariants a table has to keep:
 *
 *   ids      element ids are unique, and no two grids share a group id
 *   cells    every cell carries {grid,color,headerRow,rows,cols,r,c} with
 *            0 <= r < rows, 0 <= c < cols, and rows*cols equals the cell count
 *   tiling   cells tile the grid exactly: row widths sum to the grid width,
 *            adjacent cells share an edge, no gaps and no overlaps
 *   texts    every bound text belongs to a live cell of the same grid, sits
 *            inside that cell, and a cell never carries two texts
 *   keep     text on a cell that survives an edit is still there afterwards
 *   undo     after a committed slider resize, one Cmd+Z restores the old
 *            geometry and a redo re-applies it
 *   persist  the same holds for the scene read back from GET /api/boards/:id
 *
 * Usage:
 *   node scripts/soak-table.mjs --seed 1 --ops 30
 *   node scripts/soak-table.mjs --seeds 1..8 --ops 40
 *   node scripts/soak-table.mjs --seeds 1,3,5 --ops 60 --json
 *
 * Options:
 *   --seed N       one seed (default 1)
 *   --seeds A..B   several seeds, e.g. 1..8 or 1,4,9
 *   --ops N        operations per seed (default 30)
 *   --json         machine readable summary (human lines are quiet)
 *   --keep         keep the temp data dir and Chrome profile for debugging
 *   --headed       show the browser (debugging)
 *   --probe        print page diagnostics around insert/undo/redo, no soak
 *
 * On the first violation it prints the seed, the op log, the failing invariant,
 * a compact dump of the offending elements and saves a screenshot to
 * /tmp/table-soak/fail-<seed>-<n>.png, then exits non-zero.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "../app/node_modules/ws/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const APP_DIST = path.join(ROOT, "app/dist");
const CHROME =
  process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FAIL_DIR = "/tmp/table-soak";
const EPS = 0.5;
let quiet = false; // --json: keep the per-op chatter off stdout/stderr

/* ------------------------------------------------------------------ args */

function parseSeeds(text) {
  const out = [];
  for (const part of String(text).split(",")) {
    const chunk = part.trim();
    if (!chunk) continue;
    const range = chunk.match(/^(\d+)\s*\.\.\s*(\d+)$/);
    if (range) {
      const [a, b] = [Number(range[1]), Number(range[2])];
      for (let i = Math.min(a, b); i <= Math.max(a, b); i += 1) out.push(i);
      continue;
    }
    const n = Number(chunk);
    if (!Number.isInteger(n) || n < 0) throw new Error(`bad seed: ${chunk}`);
    out.push(n);
  }
  return out.length ? out : [1];
}

function parseArgs(argv) {
  const opts = { seeds: [1], ops: 30, json: false, keep: false, headed: false, probe: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next == null || next.startsWith("--")) throw new Error(`${arg} needs a value`);
      i += 1;
      return next;
    };
    if (arg === "--seed") opts.seeds = parseSeeds(value());
    else if (arg === "--seeds") opts.seeds = parseSeeds(value());
    else if (arg === "--ops") opts.ops = Number(value());
    else if (arg === "--json") opts.json = true;
    else if (arg === "--keep") opts.keep = true;
    else if (arg === "--headed") opts.headed = true;
    else if (arg === "--probe") opts.probe = true;
    else if (arg === "-h" || arg === "--help") {
      console.log("usage: node scripts/soak-table.mjs [--seed N] [--seeds A..B] [--ops N] [--json] [--keep] [--headed]");
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(opts.ops) || opts.ops < 1) throw new Error("--ops must be a positive integer");
  return opts;
}

/* ---------------------------------------------------------------- basics */

// mirrors GRID_MIN_COL_W / GRID_MIN_ROW_H in app/src/table.js
const MIN_COL_W = 40;
const MIN_ROW_H = 24;
/* Keep this much room between tables so growth never buries a neighbour. */
const GAP = 40;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (n) => Math.round(n * 100) / 100;
const clampTo = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const near = (a, b, eps = EPS) => Math.abs(a - b) <= eps;
/* Line breaks depend on the cell width and a squeezed value may end in "…", so
   text comparisons look at the characters only. */
const squashText = (value) => String(value ?? "").replace(/\s+/g, "").replace(/…$/, "");

function makeRng(seed) {
  // mulberry32: same seed -> same op sequence, on every machine
  let state = (seed * 2654435761) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rngInt = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const pick = (rng, list) => list[Math.floor(rng() * list.length)];

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: response.status, body };
}

/* ------------------------------------------------------------------- CDP */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.consoleErrors = [];
    this.net = []; // websocket frames and PUTs, for "the board never saved"
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
        else pending.resolve(message.result || {});
        return;
      }
      if (message.method === "Runtime.exceptionThrown") {
        const details = message.params?.exceptionDetails;
        this.consoleErrors.push(details?.exception?.description || details?.text || "exception");
      }
      if (message.method === "Runtime.consoleAPICalled" && message.params?.type === "error") {
        this.consoleErrors.push(
          (message.params.args || []).map((arg) => arg.value ?? arg.description ?? arg.type).join(" "),
        );
      }
      if (message.method === "Log.entryAdded" && message.params?.entry?.level === "error") {
        this.consoleErrors.push(message.params.entry.text);
      }
      if (message.method === "Network.webSocketFrameSent" || message.method === "Network.webSocketFrameReceived") {
        const payload = message.params?.response?.payloadData || "";
        const sent = message.method.endsWith("Sent");
        let note = payload.slice(0, 40);
        try {
          const parsed = JSON.parse(payload);
          if (parsed?.type === "update") {
            note = `update ${(parsed.scene?.elements || []).length} els`;
          } else {
            note = parsed?.type || note;
          }
        } catch {
          /* binary or truncated frame */
        }
        this.net.push({
          at: Date.now(),
          what: sent ? "ws-send" : "ws-recv",
          note,
        });
      }
      if (message.method === "Network.requestWillBeSent") {
        const request = message.params?.request || {};
        if (String(request.method).toUpperCase() === "PUT") {
          this.net.push({ at: Date.now(), what: "http-put", note: String(request.postData || "").length + "b" });
        }
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const text =
        result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        "evaluate failed";
      throw new Error(text);
    }
    return result.result?.value;
  }

  async waitFor(expression, { timeout = 12000, interval = 80, label = expression } = {}) {
    const deadline = Date.now() + timeout;
    let lastError = "";
    while (Date.now() < deadline) {
      try {
        if (await this.evaluate(expression)) return true;
      } catch (error) {
        lastError = error.message;
      }
      await sleep(interval);
    }
    throw new Error(`timeout waiting for ${label}${lastError ? ` (last: ${lastError})` : ""}`);
  }

  async mouse(type, x, y, extra = {}) {
    await this.send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: type === "mouseMoved" ? "none" : "left",
      buttons: type === "mousePressed" ? 1 : 0,
      clickCount: 1,
      ...extra,
    });
  }

  async clickPoint(x, y) {
    await this.mouse("mouseMoved", x, y);
    await this.mouse("mousePressed", x, y);
    await this.mouse("mouseReleased", x, y);
  }

  /** Two click pairs; the second one carries clickCount 2 so Chrome fires dblclick. */
  async doubleClickPoint(x, y) {
    await this.mouse("mouseMoved", x, y);
    for (const clickCount of [1, 2]) {
      await this.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        buttons: 1,
        clickCount,
      });
      await this.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        buttons: 0,
        clickCount,
      });
      await sleep(30);
    }
  }

  async dragPoint(fromX, fromY, toX, toY, steps = 8) {
    await this.mouse("mouseMoved", fromX, fromY);
    await this.mouse("mousePressed", fromX, fromY);
    for (let step = 1; step <= steps; step += 1) {
      await this.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: fromX + ((toX - fromX) * step) / steps,
        y: fromY + ((toY - fromY) * step) / steps,
        button: "left",
        buttons: 1,
      });
      await sleep(16);
    }
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: toX,
      y: toY,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
  }

  async key(key, code, vk, modifiers = 0) {
    const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  async screenshot(file) {
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    await writeFile(file, Buffer.from(data, "base64"));
  }
}

/* ------------------------------------------------------------ scene model */

const PROJ_FIELDS = ["id", "type", "x", "y", "width", "height", "text", "containerId", "isDeleted"];

/** Stable, comparable projection of a scene's elements. */
function project(elements) {
  return (elements || [])
    .filter((el) => el && el.id)
    .map((el) => {
      const row = PROJ_FIELDS.map((key) => el[key] ?? null);
      row.push(el.customData ?? null, el.groupIds ?? null);
      return row;
    })
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
}

const sceneSig = (elements) => JSON.stringify(project(elements));

function compact(el) {
  const out = {
    id: el.id,
    type: el.type,
    x: round(el.x),
    y: round(el.y),
    w: round(el.width),
    h: round(el.height),
  };
  if (el.customData) out.cd = el.customData;
  if (el.containerId) out.container = el.containerId;
  if (el.type === "text") {
    out.text = el.text;
    out.fontSize = el.fontSize;
  }
  if (el.isDeleted) out.deleted = true;
  if (el.groupIds?.length) out.group = el.groupIds;
  return out;
}

function liveCells(elements, gridId) {
  // the table frame is a rectangle with the grid's customData too; requiring a
  // numeric row/column slot keeps it out of every cell count
  return (elements || []).filter(
    (el) =>
      el.type === "rectangle" &&
      !el.isDeleted &&
      el.customData?.grid &&
      (gridId == null || el.customData.grid === gridId) &&
      Number.isFinite(el.customData?.r) &&
      Number.isFinite(el.customData?.c),
  );
}

function gridIds(elements) {
  return [...new Set(liveCells(elements).map((el) => el.customData.grid))];
}

function cellAt(elements, gridId, r, c) {
  return liveCells(elements, gridId).find(
    (el) => el.customData.r === r && el.customData.c === c,
  );
}

/** grid|r|c -> text, for every text bound to a grid cell. */
function textSlots(elements) {
  const byId = new Map((elements || []).map((el) => [el.id, el]));
  const out = new Map();
  for (const el of elements || []) {
    if (el.type !== "text" || el.isDeleted || !el.containerId) continue;
    const cell = byId.get(el.containerId);
    const cd = cell?.customData;
    if (!cd?.grid) continue;
    out.set(`${cd.grid}|${cd.r}|${cd.c}`, el.text ?? "");
  }
  return out;
}

/** grid|r|c -> true, for every live cell. */
function cellSlots(elements) {
  const out = new Set();
  for (const cell of liveCells(elements)) {
    out.add(`${cell.customData.grid}|${cell.customData.r}|${cell.customData.c}`);
  }
  return out;
}

/** grid -> {title, subtitle} */
function titleSlots(elements) {
  const out = new Map();
  for (const el of elements || []) {
    if (el.type !== "text" || el.isDeleted || !el.customData?.grid) continue;
    const slot = el.customData.title ? "title" : el.customData.subtitle ? "subtitle" : null;
    if (!slot) continue;
    const entry = out.get(el.customData.grid) || {};
    entry[slot] = el.text ?? "";
    out.set(el.customData.grid, entry);
  }
  return out;
}

/* ------------------------------------------------------------ invariants */

/**
 * Every rule the table has to keep, checked against one scene.
 * Returns [{code, message, ids}] — empty means healthy.
 */
function checkScene(elements) {
  const live = (elements || []).filter((el) => !el.isDeleted);
  const problems = [];
  const push = (code, message, ids = []) => problems.push({ code, message, ids });

  // ids ---------------------------------------------------------------
  const byId = new Map();
  for (const el of elements || []) {
    if (byId.has(el.id)) push("id-duplicate", `element id ${el.id} appears twice`, [el.id]);
    byId.set(el.id, el);
  }

  // group cells per grid ---------------------------------------------
  const cells = liveCells(elements);
  const grids = new Map();
  for (const cell of cells) {
    const gid = cell.customData.grid;
    if (!grids.has(gid)) grids.set(gid, []);
    grids.get(gid).push(cell);
  }

  // a group id may not be shared by two grids -----------------------
  const groupOwner = new Map();
  for (const [gid, list] of grids) {
    for (const cell of list) {
      for (const group of cell.groupIds || []) {
        const owner = groupOwner.get(group);
        if (owner != null && owner !== gid) {
          push("group-shared", `group ${group} is used by both grid ${owner} and grid ${gid}`, [cell.id]);
        } else {
          groupOwner.set(group, gid);
        }
      }
    }
  }

  for (const [gid, list] of grids) {
    const meta = list.map((cell) => cell.customData);
    const rows = meta[0].rows;
    const cols = meta[0].cols;

    for (const cd of meta) {
      for (const key of ["color", "headerRow", "rows", "cols", "r", "c"]) {
        if (cd[key] === undefined) {
          push("cell-meta", `grid ${gid}: cell is missing customData.${key}`, []);
          break;
        }
      }
    }

    // every cell of one grid must agree on its shape and its look
    const variants = new Map();
    for (const cell of list) {
      const cd = cell.customData;
      const key = `${cd.rows}x${cd.cols} ${cd.color} header=${cd.headerRow}`;
      const entry = variants.get(key) || { cells: [], box: null };
      entry.cells.push(cell);
      entry.box = entry.box
        ? [
            Math.min(entry.box[0], cell.x),
            Math.min(entry.box[1], cell.y),
            Math.max(entry.box[2], cell.x + cell.width),
            Math.max(entry.box[3], cell.y + cell.height),
          ]
        : [cell.x, cell.y, cell.x + cell.width, cell.y + cell.height];
      variants.set(key, entry);
    }
    if (variants.size > 1) {
      const described = [...variants.entries()]
        .map(([key, entry]) => `${entry.cells.length} cells say "${key}" in [${entry.box.map(round).join(",")}]`)
        .join(" / ");
      const offenders = [...variants.values()].slice(1).flatMap((entry) => entry.cells.slice(0, 3).map((cell) => cell.id));
      push("grid-mixed-meta", `grid ${gid}: cells disagree about {rows,cols,color,headerRow}: ${described}`, offenders);
    }
    if (!Number.isInteger(rows) || rows < 1 || !Number.isInteger(cols) || cols < 1) {
      push("cell-meta", `grid ${gid}: rows/cols are not positive integers (${rows}×${cols})`);
      continue;
    }
    if (list.length !== rows * cols) {
      push("grid-arity", `grid ${gid}: ${rows}×${cols} = ${rows * cols} cells expected, scene has ${list.length}`);
    }

    // slots ----------------------------------------------------------
    const slots = new Map();
    for (const cell of list) {
      const { r, c } = cell.customData;
      if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || c < 0 || r >= rows || c >= cols) {
        push("cell-range", `grid ${gid}: cell ${cell.id} sits at r=${r} c=${c} outside ${rows}×${cols}`, [cell.id]);
        continue;
      }
      const key = `${r}:${c}`;
      if (slots.has(key)) push("cell-duplicate", `grid ${gid}: two cells claim r=${r} c=${c}`, [cell.id, slots.get(key).id]);
      slots.set(key, cell);
    }
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        if (!slots.has(`${r}:${c}`)) push("cell-missing", `grid ${gid}: no cell at r=${r} c=${c}`);
      }
    }

    // tiling ---------------------------------------------------------
    const all = [...slots.values()];
    if (!all.length) continue;
    const left = Math.min(...all.map((cell) => cell.x));
    const right = Math.max(...all.map((cell) => cell.x + cell.width));
    const top = Math.min(...all.map((cell) => cell.y));
    const bottom = Math.max(...all.map((cell) => cell.y + cell.height));
    const width = right - left;
    const height = bottom - top;

    // no track below its documented minimum ---------------------------
    for (let c = 0; c < cols; c += 1) {
      const col = all.filter((cell) => cell.customData.c === c);
      const w = Math.max(...col.map((cell) => cell.width));
      if (w < MIN_COL_W - 0.5) {
        push("track-min-col", `grid ${gid}: column ${c} is ${round(w)}px wide, the minimum is ${MIN_COL_W}px`, all.map((cell) => cell.id));
      }
    }
    for (let r = 0; r < rows; r += 1) {
      const row = all.filter((cell) => cell.customData.r === r);
      const h = Math.max(...row.map((cell) => cell.height));
      if (h < MIN_ROW_H - 0.5) {
        push("track-min-row", `grid ${gid}: row ${r} is ${round(h)}px tall, the minimum is ${MIN_ROW_H}px`, all.map((cell) => cell.id));
      }
    }

    for (let r = 0; r < rows; r += 1) {
      const row = all.filter((cell) => cell.customData.r === r).sort((a, b) => a.customData.c - b.customData.c);
      if (row.length !== cols) continue; // already reported as cell-missing
      const sum = row.reduce((acc, cell) => acc + cell.width, 0);
      if (!near(sum, width)) {
        push("tiling-row-sum", `grid ${gid}: row ${r} widths sum to ${round(sum)} but the grid is ${round(width)} wide`, row.map((cell) => cell.id));
      }
      for (let i = 1; i < row.length; i += 1) {
        const leftEdge = row[i - 1].x + row[i - 1].width;
        if (!near(leftEdge, row[i].x)) {
          push("tiling-col-gap", `grid ${gid}: row ${r} has a ${round(row[i].x - leftEdge)}px gap/overlap between c=${i - 1} and c=${i}`, [row[i - 1].id, row[i].id]);
        }
      }
      for (const cell of row) {
        if (!near(cell.y, row[0].y) || !near(cell.height, row[0].height)) {
          push("tiling-row-shape", `grid ${gid}: row ${r} cells do not share top/height`, [cell.id, row[0].id]);
          break;
        }
      }
    }
    for (let c = 0; c < cols; c += 1) {
      const col = all.filter((cell) => cell.customData.c === c).sort((a, b) => a.customData.r - b.customData.r);
      if (col.length !== rows) continue;
      const sum = col.reduce((acc, cell) => acc + cell.height, 0);
      if (!near(sum, height)) {
        push("tiling-col-sum", `grid ${gid}: column ${c} heights sum to ${round(sum)} but the grid is ${round(height)} tall`, col.map((cell) => cell.id));
      }
      for (let i = 1; i < col.length; i += 1) {
        const topEdge = col[i - 1].y + col[i - 1].height;
        if (!near(topEdge, col[i].y)) {
          push("tiling-row-gap", `grid ${gid}: column ${c} has a ${round(col[i].y - topEdge)}px gap/overlap between r=${i - 1} and r=${i}`, [col[i - 1].id, col[i].id]);
        }
      }
      for (const cell of col) {
        if (!near(cell.x, col[0].x) || !near(cell.width, col[0].width)) {
          push("tiling-col-shape", `grid ${gid}: column ${c} cells do not share left/width`, [cell.id, col[0].id]);
          break;
        }
      }
    }
  }

  // texts -------------------------------------------------------------
  const bound = new Map(); // cellId -> [text elements]
  const seenText = new Map(); // text content -> [cellId]
  for (const el of live) {
    if (el.type !== "text" || !el.containerId) continue;
    const cell = byId.get(el.containerId);
    if (!cell || cell.isDeleted) {
      push("text-orphan", `text ${el.id} (${JSON.stringify(el.text)}) still points at missing container ${el.containerId}`, [el.id]);
      continue;
    }
    if (cell.type !== "rectangle" || !cell.customData?.grid) {
      push("text-noncell-container", `text ${el.id} is bound to ${cell.id}, which is not a grid cell`, [el.id, cell.id]);
      continue;
    }
    const cd = cell.customData;
    if (!bound.has(cell.id)) bound.set(cell.id, []);
    bound.get(cell.id).push(el);

    if (el.customData?.grid && el.customData.grid !== cd.grid) {
      push("text-grid-mismatch", `text ${el.id} says grid ${el.customData.grid} but its cell ${cell.id} belongs to ${cd.grid}`, [el.id, cell.id]);
    }
    if (el.customData && (el.customData.r !== cd.r || el.customData.c !== cd.c)) {
      push("text-slot-mismatch", `text ${el.id} says r=${el.customData.r} c=${el.customData.c} but its cell sits at r=${cd.r} c=${cd.c}`, [el.id, cell.id]);
    }
    if (
      el.x < cell.x - 1 ||
      el.x + el.width > cell.x + cell.width + 1 ||
      el.y < cell.y - 1 ||
      el.y + el.height > cell.y + cell.height + 1
    ) {
      push(
        "text-outside",
        `text ${JSON.stringify(el.text)} (${el.id}) at ${round(el.x)},${round(el.y)} ${round(el.width)}×${round(el.height)} does not fit cell ${cell.id} at ${round(cell.x)},${round(cell.y)} ${round(cell.width)}×${round(cell.height)}`,
        [el.id, cell.id],
      );
    }
    const value = String(el.text ?? "").trim();
    // identical *content* on two cells is only suspicious for real words, so a
    // short "1" typed twice by hand does not trip the harness
    if (value.length >= 4) {
      if (!seenText.has(value)) seenText.set(value, []);
      seenText.get(value).push(cell.id);
    }
  }
  for (const [cellId, list] of bound) {
    if (list.length > 1) {
      push("text-two-per-cell", `cell ${cellId} carries ${list.length} texts: ${list.map((el) => el.id).join(", ")}`, [cellId, ...list.map((el) => el.id)]);
    }
  }
  for (const [value, cellIds] of seenText) {
    if (new Set(cellIds).size > 1) {
      push("text-duplicate", `text ${JSON.stringify(value)} appears on ${new Set(cellIds).size} cells`, [...new Set(cellIds)]);
    }
  }

  // a grid carries at most one title and one subtitle -------------------
  for (const [gid] of grids) {
    for (const slot of ["title", "subtitle"]) {
      const found = live.filter(
        (el) => el.type === "text" && !el.isDeleted && el.customData?.grid === gid && el.customData[slot],
      );
      if (found.length > 1) {
        push(`text-many-${slot}`, `grid ${gid} has ${found.length} ${slot} texts`, found.map((el) => el.id));
      }
    }
  }

  return problems;
}

/** Insert-only invariant: the new table must not land on top of another grid. */
function checkNoGridOverlap(elements) {
  const grids = new Map();
  for (const cell of liveCells(elements)) {
    const gid = cell.customData.grid;
    const box = grids.get(gid) || { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
    box.left = Math.min(box.left, cell.x);
    box.top = Math.min(box.top, cell.y);
    box.right = Math.max(box.right, cell.x + cell.width);
    box.bottom = Math.max(box.bottom, cell.y + cell.height);
    grids.set(gid, box);
  }
  const entries = [...grids.entries()];
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const [aId, a] = entries[i];
      const [bId, b] = entries[j];
      const disjoint =
        a.right <= b.left + EPS ||
        b.right <= a.left + EPS ||
        a.bottom <= b.top + EPS ||
        b.bottom <= a.top + EPS;
      if (!disjoint) {
        return [
          {
            code: "grid-overlap",
            message: `grid ${aId} (${round(a.left)}..${round(a.right)} × ${round(a.top)}..${round(a.bottom)}) overlaps grid ${bId} (${round(b.left)}..${round(b.right)} × ${round(b.top)}..${round(b.bottom)})`,
            ids: liveCells(elements, aId).map((cell) => cell.id).concat(liveCells(elements, bId).map((cell) => cell.id)),
          },
        ];
      }
    }
  }
  return [];
}

class Fail extends Error {
  constructor(code, message, ids = []) {
    super(message);
    this.code = code;
    this.ids = ids;
  }
}

/* ---------------------------------------------------------------- server */

async function startServer({ dataDir, galleryDir, appDir }) {
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(ROOT, "app/server.mjs")], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      GALLERY_DIR: galleryDir,
      APP_DIR: appDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  proc.stdout.on("data", (chunk) => {
    log += chunk.toString();
  });
  proc.stderr.on("data", (chunk) => {
    log += chunk.toString();
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const health = await fetchJson(`${base}/api/health`);
      if (health.status === 200 && health.body?.ok) return { base, proc, port };
    } catch {
      /* not up yet */
    }
    await sleep(120);
  }
  proc.kill("SIGKILL");
  throw new Error(`app/server.mjs did not start on ${port}\n${log}`);
}

async function launchChrome({ headed }) {
  const port = await freePort();
  const profile = await mkdtemp(path.join(os.tmpdir(), "soak-chrome-"));
  const args = [
    headed ? "--no-sandbox" : "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--window-size=1600,1000",
    "about:blank",
  ];
  const proc = spawn(CHROME, args, { stdio: "ignore" });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const list = await fetchJson(`http://127.0.0.1:${port}/json/list`);
      const page = Array.isArray(list.body) && list.body.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) {
        const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
        await new Promise((resolve, reject) => {
          ws.once("open", resolve);
          ws.once("error", reject);
        });
        const cdp = new CDP(ws);
        await cdp.send("Page.enable");
        await cdp.send("Runtime.enable");
        await cdp.send("Log.enable");
        await cdp.send("Network.enable");
        return { cdp, proc, profile, port };
      }
    } catch {
      /* chrome not listening yet */
    }
    await sleep(120);
  }
  proc.kill("SIGKILL");
  throw new Error("headless Chrome did not expose a page target");
}

/* --------------------------------------------------------------- the app */

class Page {
  constructor(cdp, base, boardId) {
    this.cdp = cdp;
    this.base = base;
    this.boardId = boardId;
    this.url = `${base}/b/${boardId}`;
  }

  /**
   * Record what the page actually sends to the server (HTTP PUT and websocket
   * frames). When the board on disk lags behind the screen this tells us
   * whether the client never sent, or the server dropped it.
   */
  async installIoRecorder() {
    await this.cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => {
        window.__soakIO = { puts: 0, ws: 0, lastPutElements: null, lastWsElements: null };
        const realFetch = window.fetch;
        window.fetch = function (...args) {
          try {
            const method = String(args[1]?.method || "GET").toUpperCase();
            if (method === "PUT") {
              window.__soakIO.puts += 1;
              try { window.__soakIO.lastPutElements = (JSON.parse(args[1].body)?.elements || []).length; } catch {}
            }
          } catch {}
          return realFetch.apply(this, args);
        };
        window.__soakBodies = [];
        const realStringify = JSON.stringify;
        JSON.stringify = function (value, ...rest) {
          const text = realStringify.call(this, value, ...rest);
          try {
            if (value && typeof value === "object" && value.type === "excalidraw" && !value.__soakSeen) {
              window.__soakBodies.push({ at: Date.now(), elements: (value.elements || []).length });
            }
          } catch {}
          return text;
        };
        const realSend = WebSocket.prototype.send;
        WebSocket.prototype.send = function (data) {
          try {
            const message = JSON.parse(data);
            if (message?.type === "update") {
              window.__soakIO.ws += 1;
              window.__soakIO.lastWsElements = (message.scene?.elements || []).length;
            }
          } catch {}
          return realSend.call(this, data);
        };
      })();`,
    });
  }

  async ioStats() {
    return this.cdp.evaluate(
      `(() => ({ io: window.__soakIO || null, bodies: (window.__soakBodies || []).slice(-12) }))()`,
    );
  }

  /** Last few save-related frames, relative to the first one. */
  netTail(count = 8) {
    const tail = this.cdp.net.slice(-count);
    const base = tail.length ? tail[0].at : Date.now();
    return tail.map((entry) => `+${entry.at - base}ms ${entry.what} ${entry.note}`).join(" | ");
  }

  async open() {
    await this.installIoRecorder();
    await this.cdp.send("Page.navigate", { url: this.url });
    await this.cdp.waitFor(
      `document.readyState === "complete" && !!window.__boardsApi && !!document.querySelector(".tools-table") && !document.querySelector(".bar")`,
      { timeout: 25000, label: "editor ready" },
    );
    await this.settle();
    await this.openPanel();
  }

  async reload() {
    await this.cdp.send("Page.reload", { ignoreCache: false });
    await this.cdp.waitFor(
      `document.readyState === "complete" && !!window.__boardsApi && !!document.querySelector(".tools-table") && !document.querySelector(".bar")`,
      { timeout: 25000, label: "editor reload" },
    );
    await sleep(200);
    await this.settle();
    await this.openPanel();
  }

  async openPanel() {
    const open = await this.cdp.evaluate(`!!document.querySelector(".panel.open")`);
    if (!open) await this.clickSelector(".tools-table");
    await this.cdp.waitFor(`!!document.querySelector(".panel.open")`, { timeout: 5000, label: "panel open" });
    await this.stableBox(".panel"); // the panel slides in; wait for it to stop
  }

  /**
   * Wait until a box stops moving before clicking it: the table panel slides in
   * from the right, so its button rect read at the start of the animation is
   * still a hundred pixels off screen.
   */
  async stableBox(selector, timeout = 2500) {
    const read = () =>
      this.cdp.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return null;
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, top: r.top };
      })()`);
    let previous = null;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const box = await read();
      if (box && previous && Math.abs(box.left - previous.left) < 0.5 && Math.abs(box.top - previous.top) < 0.5) {
        return box;
      }
      previous = box;
      await sleep(60);
    }
    return previous;
  }

  /** Tag one element with data-soak-target, click its settled box, untag it. */
  async clickMarked(finderJs, what) {
    const found = await this.cdp.evaluate(`(() => {
      const el = ${finderJs};
      if (!el) return false;
      el.setAttribute("data-soak-target", "1");
      el.scrollIntoView({ block: "center", inline: "center" });
      return true;
    })()`);
    if (!found) throw new Fail("ui-missing", `cannot click ${what}`);
    const box = await this.stableBox('[data-soak-target="1"]');
    await this.cdp.evaluate(`document.querySelector('[data-soak-target="1"]')?.removeAttribute("data-soak-target")`);
    if (!box) throw new Fail("ui-missing", `${what} has no box`);
    await this.cdp.clickPoint(box.x, box.y);
    await sleep(80);
  }

  async clickSelector(selector) {
    await this.clickMarked(`document.querySelector(${JSON.stringify(selector)})`, selector);
  }

  /** Read the live scene plus the bits of appState the harness needs. */
  async snapshot() {
    const data = await this.cdp.evaluate(`(() => {
      const api = window.__boardsApi;
      if (!api) return null;
      const state = api.getAppState();
      // including deleted: Excalidraw keeps an undo of an insert as "all these
      // elements are now deleted", and the board on disk stores that same list.
      // Comparing the visible list with the file would never match.
      return {
        elements: api.getSceneElementsIncludingDeleted
          ? api.getSceneElementsIncludingDeleted()
          : api.getSceneElements(),
        live: api.getSceneElements().length,
        selected: Object.keys(state.selectedElementIds || {}),
        editing: !!document.querySelector("textarea.excalidraw-wysiwyg"),
      };
    })()`);
    if (!data) throw new Fail("page-dead", "window.__boardsApi disappeared");
    return data;
  }

  /** Wait until two consecutive reads agree (Excalidraw renders synchronously). */
  async settle(timeout = 3000) {
    const deadline = Date.now() + timeout;
    let previous = null;
    while (Date.now() < deadline) {
      const scene = await this.snapshot();
      const sig = sceneSig(scene.elements);
      if (sig === previous) return scene;
      previous = sig;
      await sleep(70);
    }
    return this.snapshot();
  }

  async selectedGrid() {
    const scene = await this.snapshot();
    const byId = new Map(scene.elements.map((el) => [el.id, el]));
    for (const id of scene.selected) {
      const grid = byId.get(id)?.customData?.grid;
      if (grid) return grid;
    }
    return null;
  }

  /** Scroll one grid (or one cell) into the middle so the panel never covers it. */
  async reveal(gridId, r, c) {
    await this.cdp.evaluate(`(() => {
      const api = window.__boardsApi;
      const cells = api.getSceneElements().filter(
        (el) => el.type === "rectangle" && !el.isDeleted && el.customData?.grid === ${JSON.stringify(gridId)} &&
          Number.isFinite(el.customData?.r) && Number.isFinite(el.customData?.c),
      );
      const target = ${
        r == null
          ? "cells"
          : `cells.filter((el) => el.customData.r === ${r} && el.customData.c === ${c})`
      };
      if (!target.length) return false;
      api.scrollToContent(target, { fitToContent: false, animate: false });
      return true;
    })()`);
    await sleep(80);
  }

  /** Client coordinates of one cell's centre. */
  async cellPoint(gridId, r, c) {
    const point = await this.cdp.evaluate(`(() => {
      const api = window.__boardsApi;
      const state = api.getAppState();
      const zoom = state.zoom?.value || 1;
      const host = document.querySelector(".canvas");
      if (!host) return null;
      const rect = host.getBoundingClientRect();
      const cell = api.getSceneElements().find(
        (el) => el.type === "rectangle" && !el.isDeleted &&
          el.customData?.grid === ${JSON.stringify(gridId)} &&
          el.customData?.r === ${r} && el.customData?.c === ${c},
      );
      if (!cell) return null;
      const sceneX = cell.x + cell.width / 2;
      const sceneY = cell.y + cell.height / 2;
      return {
        x: rect.left + (sceneX + (state.scrollX || 0)) * zoom,
        y: rect.top + (sceneY + (state.scrollY || 0)) * zoom,
        innerWidth: window.innerWidth,
      };
    })()`);
    if (!point) throw new Fail("ui-missing", `no cell ${gridId} r=${r} c=${c}`);
    return point;
  }

  async clickCell(gridId, r, c) {
    await this.reveal(gridId, r, c);
    const point = await this.cellPoint(gridId, r, c);
    await this.cdp.clickPoint(point.x, point.y);
    await sleep(60);
  }

  async setField(label, value) {
    const ok = await this.cdp.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(`input[aria-label="${label}"]`)});
      if (!el) return null;
      el.focus();
      const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
      descriptor.set.call(el, ${JSON.stringify(String(value))});
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return el.value;
    })()`);
    if (ok == null) throw new Fail("ui-missing", `no field "${label}"`);
    return ok;
  }

  async fieldValue(label) {
    return this.cdp.evaluate(
      `document.querySelector(${JSON.stringify(`input[aria-label="${label}"]`)})?.value ?? null`,
    );
  }

  async selectColor(name) {
    const ok = await this.cdp.evaluate(`(() => {
      const el = document.querySelector(".panel select");
      if (!el) return false;
      const descriptor = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value");
      descriptor.set.call(el, ${JSON.stringify(name)});
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return el.value === ${JSON.stringify(name)};
    })()`);
    if (!ok) throw new Fail("ui-missing", `.panel select cannot be set to ${name}`);
  }

  async setTitle(value) {
    const ok = await this.cdp.evaluate(`(() => {
      const el = document.querySelector('.panel input[placeholder="inventory.lot"]');
      if (!el) return false;
      el.focus();
      const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
      descriptor.set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    if (!ok) throw new Fail("ui-missing", "no title field");
  }

  async toggleHeader() {
    await this.clickSelector('label.check input[type="checkbox"]');
  }

  async button(text) {
    await this.clickMarked(
      `[...document.querySelectorAll(".panel button")].find((node) => node.textContent.trim() === ${JSON.stringify(text)})`,
      `panel button "${text}"`,
    );
  }

  async update() {
    await this.button("อัปเดตตารางที่เลือก");
  }

  async insert() {
    await this.button("แทรกตารางใหม่");
  }

  async grow(axis) {
    await this.button(axis === "row" ? "+ 1 แถว" : "+ 1 คอลัมน์");
  }

  /** Drag one of the two size sliders by `delta` px and let go (commits). */
  async dragSlider(kind, delta) {
    const label =
      kind === "row" ? "สไลเดอร์ความสูงของแถวที่เลือก" : "สไลเดอร์ความกว้างของคอลัมน์ที่เลือก";
    const box = await this.cdp.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(`input[aria-label="${label}"]`)});
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || el.disabled) return null;
      const min = Number(el.min), max = Number(el.max), value = Number(el.value);
      const usable = r.width - 16;
      return {
        x: r.left + 8 + ((value - min) / (max - min)) * usable,
        y: r.top + r.height / 2,
        width: r.width,
        value,
      };
    })()`);
    if (!box) throw new Fail("ui-missing", `slider "${kind}" is not usable`);
    const toX = Math.max(8, Math.min(box.width - 8, box.x + delta));
    await this.cdp.mouse("mouseMoved", box.x, box.y);
    await this.cdp.mouse("mousePressed", box.x, box.y);
    for (let i = 1; i <= 5; i += 1) {
      await this.cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: box.x + ((toX - box.x) * i) / 5,
        y: box.y,
        button: "left",
        buttons: 1,
      });
      await sleep(30);
    }
    await this.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: toX,
      y: box.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    await sleep(120);
    return { from: box.value, delta: Math.round(toX - box.x) };
  }

  async dragCell(gridId, r, c, dx, dy) {
    await this.reveal(gridId, r, c);
    const point = await this.cellPoint(gridId, r, c);
    await this.cdp.dragPoint(point.x, point.y, point.x + dx, point.y + dy, 8);
    await sleep(80);
  }

  /** Double-click a cell, replace whatever is in it, commit with Escape. */
  async typeIntoCell(gridId, r, c, text) {
    await this.reveal(gridId, r, c);
    const point = await this.cellPoint(gridId, r, c);
    await this.cdp.doubleClickPoint(point.x, point.y);
    await this.cdp.waitFor(`!!document.querySelector("textarea.excalidraw-wysiwyg")`, {
      timeout: 5000,
      label: `text editor for ${gridId} r=${r} c=${c}`,
    });
    // select whatever the cell already holds, then replace it in one go
    await this.cdp.key("a", "KeyA", 65, 4);
    await this.cdp.send("Input.insertText", { text });
    await sleep(60);
    await this.cdp.key("Escape", "Escape", 27);
    await this.cdp.waitFor(`!document.querySelector("textarea.excalidraw-wysiwyg")`, {
      timeout: 5000,
      label: "text editor closed",
    });
    await sleep(80);
  }

  /**
   * Undo/redo are Excalidraw shortcuts: they only reach the scene when the
   * canvas has focus. After dragging a panel slider the focus sits on the
   * slider, so a person clicks the board first — the harness does the same.
   */
  async focusCanvas() {
    await this.cdp.evaluate(`(() => {
      const active = document.activeElement;
      if (active && active !== document.body && typeof active.blur === "function") active.blur();
      const host = document.querySelector(".excalidraw") || document.querySelector(".canvas");
      if (host && typeof host.focus === "function") host.focus({ preventScroll: true });
      return document.activeElement ? document.activeElement.className || document.activeElement.tagName : null;
    })()`);
  }

  async undo() {
    await this.focusCanvas();
    await this.cdp.key("z", "KeyZ", 90, 4);
    await sleep(160);
  }

  async redo() {
    await this.focusCanvas();
    await this.cdp.key("z", "KeyZ", 90, 4 | 8);
    await sleep(160);
  }
}

/* ------------------------------------------------------------- geometry */

function geometryOf(elements, gridId) {
  const cells = liveCells(elements, gridId);
  const cols = new Map();
  const rows = new Map();
  for (const cell of cells) {
    const { r, c } = cell.customData;
    rows.set(r, { top: cell.y, height: cell.height });
    cols.set(c, { left: cell.x, width: cell.width });
  }
  const left = Math.min(...cells.map((cell) => cell.x));
  const top = Math.min(...cells.map((cell) => cell.y));
  const right = Math.max(...cells.map((cell) => cell.x + cell.width));
  const bottom = Math.max(...cells.map((cell) => cell.y + cell.height));
  return {
    rows: [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([r, v]) => [r, round(v.height)]),
    cols: [...cols.entries()].sort((a, b) => a[0] - b[0]).map(([c, v]) => [c, round(v.width)]),
    box: [round(left), round(top), round(right - left), round(bottom - top)],
    count: cells.length,
  };
}

const sameGeometry = (a, b) =>
  !!a &&
  !!b &&
  JSON.stringify(a.rows) === JSON.stringify(b.rows) &&
  JSON.stringify(a.cols) === JSON.stringify(b.cols) &&
  JSON.stringify(a.box) === JSON.stringify(b.box);

/* --------------------------------------------------------------- the run */

const OPS = [
  ["cell-text", 4],
  ["count-up", 3],
  ["count-down", 3],
  ["size-total", 3],
  ["row-slider", 4],
  ["col-slider", 4],
  ["undo", 3],
  ["redo", 2],
  ["insert", 2],
  ["header", 2],
  ["color", 2],
  ["title", 2],
  ["grow-row", 2],
  ["grow-col", 2],
  ["move", 2],
  ["select-other", 2],
  ["reload", 1],
];

const COLORS = ["gray", "blue", "green", "yellow", "orange", "red", "violet", "cyan"];

class Soak {
  constructor({ page, base, boardId, seed, ops }) {
    this.page = page;
    this.cdp = page.cdp;
    this.base = base;
    this.boardId = boardId;
    this.seed = seed;
    this.ops = ops;
    this.rng = makeRng(seed);
    this.log = [];
    this.markers = 0;
    this.persistedWarnings = 0;
  }

  async opLog(line) {
    this.log.push(line);
  }

  async live() {
    return (await this.page.settle()).elements;
  }

  async persisted() {
    const response = await fetchJson(`${this.base}/api/boards/${encodeURIComponent(this.boardId)}`);
    return Array.isArray(response.body?.elements) ? response.body.elements : null;
  }

  /** Wait until the board on disk matches the live scene. */
  async waitSaved(live, timeout = 12000) {
    const target = sceneSig(live);
    const deadline = Date.now() + timeout;
    let last = null;
    while (Date.now() < deadline) {
      last = await this.persisted();
      if (last && sceneSig(last) === target) return last;
      await sleep(90);
    }
    return null;
  }

  pickGrid(exclude) {
    return this.live().then((elements) => {
      const ids = gridIds(elements).filter((id) => id !== exclude);
      return ids.length ? pick(this.rng, ids) : null;
    });
  }

  async ensureSelected() {
    let grid = await this.page.selectedGrid();
    if (grid) return grid;
    let elements = await this.live();
    if (!gridIds(elements).length) {
      // an undo can take the last table off the board (that is a legitimate
      // undo of the insert); a person would just press "แทรกตารางใหม่" again
      await this.page.insert();
      elements = await this.live();
      await this.opLog("  · board had no table left, re-inserted one");
    }
    grid = gridIds(elements)[0] ?? null;
    if (!grid) throw new Fail("setup", "no table on the board");
    const cells = liveCells(elements, grid);
    const cell = pick(this.rng, cells);
    await this.page.clickCell(grid, cell.customData.r, cell.customData.c);
    await this.live();
    grid = await this.page.selectedGrid();
    if (!grid) throw new Fail("select", "clicking a cell did not select its table");
    return grid;
  }

  /**
   * A cell of `grid` that a synthetic click can actually reach: inside the viewport,
   * clear of the panel, and not painted over by a cell of another table (a table a
   * previous op dragged on top of this one would swallow the click).
   */
  async clickableCell(grid) {
    const elements = await this.live();
    const cells = liveCells(elements, grid);
    for (const cell of cells.sort(() => this.rng() - 0.5)) {
      await this.page.reveal(grid, cell.customData.r, cell.customData.c);
      const point = await this.page.cellPoint(grid, cell.customData.r, cell.customData.c);
      if (!(point.x > 16 && point.x < point.innerWidth - 420 && point.y > 16)) continue;
      const covered = await this.page.cdp.evaluate(`(() => {
        const api = window.__boardsApi;
        const state = api.getAppState();
        const zoom = state.zoom?.value || 1;
        const rect = document.querySelector(".canvas").getBoundingClientRect();
        const sx = (${JSON.stringify(point.x)} - rect.left) / zoom - (state.scrollX || 0);
        const sy = (${JSON.stringify(point.y)} - rect.top) / zoom - (state.scrollY || 0);
        return api.getSceneElements().some(
          (el) => el.type === "rectangle" && el.customData?.grid && el.customData.grid !== ${JSON.stringify(grid)} &&
            sx >= el.x - 1 && sx <= el.x + el.width + 1 && sy >= el.y - 1 && sy <= el.y + el.height + 1,
        );
      })()`);
      if (!covered) return { cell, point };
    }
    throw new Fail("ui-covered", `every cell of ${grid} is covered or off-screen, a click cannot land`);
  }

  /**
   * Room between `grid` and the next table on its right/bottom. Tables grow from
   * their own origin, so this is how much the total width/height may become without
   * running into a neighbour (the soak keeps the board tidy, and keeps every cell
   * clickable for the next op).
   */
  async roomAround(grid) {
    const boxes = tracks(await this.live());
    const mine = boxes.find((entry) => entry.grid === grid)?.box;
    if (!mine) return { width: Infinity, height: Infinity };
    const [x, y, w, h] = mine;
    let right = Infinity;
    let bottom = Infinity;
    for (const other of boxes) {
      if (other.grid === grid) continue;
      const [ox, oy, ow, oh] = other.box;
      const overlapsV = oy < y + h - EPS && oy + oh > y + EPS;
      const overlapsH = ox < x + w - EPS && ox + ow > x + EPS;
      if (overlapsV && ox >= x + w - EPS) right = Math.min(right, ox - GAP);
      if (overlapsH && oy >= y + h - EPS) bottom = Math.min(bottom, oy - GAP);
    }
    return { width: right === Infinity ? Infinity : right - x, height: bottom === Infinity ? Infinity : bottom - y };
  }

  /* --------------------------------------------------------------- ops */

  async op(name) {
    const page = this.page;
    const rng = this.rng;

    if (name === "insert") {
      const before = await this.live();
      const beforeIds = new Set(gridIds(before));
      await page.insert();
      const after = await this.live();
      const added = gridIds(after).filter((id) => !beforeIds.has(id));
      if (added.length !== 1) {
        throw new Fail("insert", `inserting a table should add exactly one grid, added ${added.length}`, []);
      }
      const overlap = checkNoGridOverlap(after);
      if (overlap.length) throw new Fail(overlap[0].code, overlap[0].message, overlap[0].ids);
      await this.opLog(`insert grid=${added[0]} (${gridIds(after).length} grids)`);
      return `inserted grid ${added[0]}`;
    }

    if (name === "select-other") {
      const grids = gridIds(await this.live());
      if (grids.length < 2) {
        await page.insert();
        await this.opLog("select-other -> only one grid, inserted another");
        return "inserted a table instead";
      }
      const current = await page.selectedGrid();
      const target = pick(rng, grids.filter((id) => id !== current));
      const { cell, point } = await this.clickableCell(target);
      await page.clickCell(target, cell.customData.r, cell.customData.c);
      const scene = await page.settle();
      const now = await page.selectedGrid();
      if (now !== target) {
        // what is actually under that point, in canvas coordinates?
        const under = await page.cdp.evaluate(`(() => {
          const api = window.__boardsApi;
          const state = api.getAppState();
          const zoom = state.zoom?.value || 1;
          const rect = document.querySelector(".canvas").getBoundingClientRect();
          const sx = (${JSON.stringify(point.x)} - rect.left) / zoom - (state.scrollX || 0);
          const sy = (${JSON.stringify(point.y)} - rect.top) / zoom - (state.scrollY || 0);
          const hits = api.getSceneElements()
            .filter((el) => el.type === "rectangle" && sx >= el.x - 1 && sx <= el.x + el.width + 1 && sy >= el.y - 1 && sy <= el.y + el.height + 1)
            .map((el) => ({ id: el.id, grid: el.customData?.grid, r: el.customData?.r, c: el.customData?.c }));
          return { sx: Math.round(sx), sy: Math.round(sy), hits };
        })()`);
        throw new Fail(
          "select",
          `clicked a cell of ${target} at ${round(point.x)},${round(point.y)} = scene ${under.sx},${under.sy}, which hits ${JSON.stringify(under.hits)}; panel tracks ${now}; grids ${JSON.stringify(tracks(scene.elements))}`,
        );
      }
      const selectedCells = scene.elements.filter(
        (el) => scene.selected.includes(el.id) && el.customData?.grid && el.customData.grid !== target,
      );
      if (selectedCells.length) {
        throw new Fail(
          "select-bleed",
          `selecting grid ${target} also selected ${selectedCells.length} cells of ${selectedCells[0].customData.grid}`,
          selectedCells.map((el) => el.id),
        );
      }
      await this.opLog(`select-other grid=${target} (was ${current}) r=${cell.customData.r} c=${cell.customData.c}`);
      return `selected ${target}`;
    }

    const grid = await this.ensureSelected();

    if (name === "cell-text" || name === "move" || name === "row-slider" || name === "col-slider") {
      const { cell } = await this.clickableCell(grid);
      await page.clickCell(grid, cell.customData.r, cell.customData.c);
      const scene = await page.settle();
      const active = liveCells(scene.elements, grid).find(
        (el) => el.customData.r === cell.customData.r && el.customData.c === cell.customData.c,
      );
      if (!active) throw new Fail("ui-missing", "clicked cell vanished");

      if (name === "cell-text") {
        this.markers += 1;
        const marker = `soak-${String(this.markers).padStart(2, "0")}`;
        await page.typeIntoCell(grid, cell.customData.r, cell.customData.c, marker);
        const after = await this.live();
        const target = cellAt(after, grid, cell.customData.r, cell.customData.c);
        const text = after.find((el) => el.type === "text" && el.containerId === target?.id);
        // the cell may re-wrap or shrink the value to keep it inside the box, so
        // compare the characters and not the line breaks
        if (!text || squashText(text.text) !== squashText(marker)) {
          throw new Fail(
            "type-cell",
            `typed ${JSON.stringify(marker)} into ${grid} r=${cell.customData.r} c=${cell.customData.c}, cell holds ${JSON.stringify(text?.text ?? null)}`,
            target ? [target.id] : [],
          );
        }
        await this.opLog(`cell-text grid=${grid} r=${cell.customData.r} c=${cell.customData.c} "${marker}"`);
        return `typed ${marker}`;
      }

      if (name === "move") {
        // drags stay clear of the other tables: two tables on the same spot are the
        // person's choice in a real board, but here they would hide each other from
        // the next click (and the board is checked for overlaps after every op)
        const boxes = tracks(await this.live());
        const mine = boxes.find((entry) => entry.grid === grid)?.box;
        const others = boxes.filter((entry) => entry.grid !== grid).map((entry) => entry.box);
        const options = [-2, -1, 1, 2].flatMap((steps) => [
          [steps * 40, 0],
          [0, steps * 40],
        ]);
        const clear = options.filter(([dx, dy]) => {
          if (!mine) return true;
          const box = [mine[0] + dx, mine[1] + dy, mine[2], mine[3]];
          return others.every(
            (other) =>
              box[0] + box[2] <= other[0] - 20 ||
              other[0] + other[2] <= box[0] - 20 ||
              box[1] + box[3] <= other[1] - 20 ||
              other[1] + other[3] <= box[1] - 20,
          );
        });
        if (!clear.length) {
          await this.opLog(`move grid=${grid} skipped: every direction runs into another table`);
          return "no room to move";
        }
        const [dx, dy] = pick(rng, clear);
        const before = geometryOf(await this.live(), grid);
        await page.dragCell(grid, cell.customData.r, cell.customData.c, dx, dy);
        const after = geometryOf(await this.live(), grid);
        const moved = round(after.box[0] - before.box[0]);
        await this.opLog(`move grid=${grid} by ${dx},${dy} (moved ${moved},${round(after.box[1] - before.box[1])})`);
        return `dragged ${grid} by ${dx},${dy}`;
      }

      const kind = name === "row-slider" ? "row" : "col";
      const before = geometryOf(await this.live(), grid);
      const drag = await page.dragSlider(kind, rngInt(rng, -140, 140));
      const after = geometryOf(await this.live(), grid);
      const changed = !sameGeometry(before, after);
      await this.opLog(
        `slider ${kind} grid=${grid} drag ${drag.delta}px value ${drag.from} -> ${changed ? "changed" : "no-op"}`,
      );
      if (!changed) return `slider ${kind} did not move (no-op)`;

      // one Cmd+Z must restore the old geometry, the redo must re-apply the new
      await page.undo();
      const undone = geometryOf(await this.live(), grid);
      if (!sameGeometry(undone, before)) {
        throw new Fail(
          "resize-undo",
          `one Cmd+Z after a ${kind} slider drag did not restore the previous geometry: expected ${JSON.stringify(before)} got ${JSON.stringify(undone)}`,
          liveCells(await this.live(), grid).map((el) => el.id),
        );
      }
      await page.redo();
      const redone = geometryOf(await this.live(), grid);
      if (!sameGeometry(redone, after)) {
        throw new Fail(
          "resize-redo",
          `Cmd+Shift+Z did not re-apply the ${kind} resize: expected ${JSON.stringify(after)} got ${JSON.stringify(redone)}`,
          liveCells(await this.live(), grid).map((el) => el.id),
        );
      }
      await this.opLog(`slider ${kind} undo/redo ok (${JSON.stringify(before.box)} -> ${JSON.stringify(after.box)})`);
      return `${kind} slider ${drag.delta}px, undo+redo ok`;
    }

    if (name === "undo") {
      await page.undo();
      await this.opLog("undo Cmd+Z");
      return "undo";
    }

    if (name === "redo") {
      await page.redo();
      await this.opLog("redo Cmd+Shift+Z");
      return "redo";
    }

    if (name === "reload") {
      const before = await this.live();
      if (!(await this.waitSaved(before))) {
        throw new Fail("save-timeout", "the board on disk never matched the live scene before the reload", []);
      }
      await page.reload();
      const after = await this.live();
      const beforeGrids = gridIds(before).sort();
      const afterGrids = gridIds(after).sort();
      if (JSON.stringify(beforeGrids) !== JSON.stringify(afterGrids)) {
        throw new Fail(
          "reload-grids",
          `reload changed the grids: ${JSON.stringify(beforeGrids)} -> ${JSON.stringify(afterGrids)}`,
          [],
        );
      }
      for (const id of beforeGrids) {
        const a = geometryOf(before, id);
        const b = geometryOf(after, id);
        if (!sameGeometry(a, b)) {
          throw new Fail(
            "reload-geometry",
            `grid ${id} geometry changed across reload: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`,
            liveCells(after, id).map((el) => el.id),
          );
        }
      }
      await this.opLog(`reload ok (${beforeGrids.length} grids, ${after.filter((el) => el.customData?.grid).length} table elements)`);
      return "reloaded";
    }

    // panel edits: set the fields, press the update button -------------
    const scene = await this.live();
    const info = {
      cols: Math.max(...liveCells(scene, grid).map((el) => el.customData.c)) + 1,
      rows: Math.max(...liveCells(scene, grid).map((el) => el.customData.r)) + 1,
      box: geometryOf(scene, grid).box,
    };

    if (name === "count-up" || name === "count-down") {
      let axis = rng() < 0.5 ? "cols" : "rows";
      const delta = rngInt(rng, 1, 3);
      const floor = { cols: 1, rows: 1 };
      const ceiling = { cols: 20, rows: 50 };
      if (name === "count-down" && info[axis] <= floor[axis]) {
        // one column (or row) is the smallest table there is: shrink the other axis,
        // and when neither can shrink this op grows instead
        const other = axis === "cols" ? "rows" : "cols";
        if (info[other] > floor[other]) axis = other;
      }
      const current = info[axis];
      const limit = ceiling[axis];
      let next = name === "count-up" ? current + delta : current - delta;
      next = Math.max(floor[axis], Math.min(limit, next));
      if (next === current) {
        next = name === "count-up" ? Math.min(limit, current + 1) : Math.min(limit, current + delta);
      }
      if (next === current) throw new Fail("panel", `${axis} cannot move from ${current}`);
      const label = axis === "cols" ? "จำนวนคอลัมน์" : "จำนวนแถว";
      await this.setAndApply(label, next);
      const after = await this.live();
      const nextCols = Math.max(...liveCells(after, grid).map((el) => el.customData.c)) + 1;
      const nextRows = Math.max(...liveCells(after, grid).map((el) => el.customData.r)) + 1;
      if ((axis === "cols" ? nextCols : nextRows) !== next) {
        throw new Fail(
          "panel-count",
          `asked for ${axis}=${next}, the grid now has ${nextCols}×${nextRows}`,
          liveCells(after, grid).map((el) => el.id),
        );
      }
      const other = axis === "cols" ? nextRows : nextCols;
      if (other !== (axis === "cols" ? info.rows : info.cols)) {
        throw new Fail("panel-count", `changing ${axis} also changed the other axis: ${JSON.stringify(info)} -> ${nextCols}×${nextRows}`);
      }
      await this.opLog(`count ${axis} ${current} -> ${next}`);
      return `${axis} ${current} → ${next}`;
    }

    if (name === "size-total") {
      // the panel may ask for a total that cannot hold the minimum track sizes;
      // the grid then has to be exactly max(asked, cols*40) x max(asked, rows*24)
      const cols = info.cols;
      const rows = info.rows;
      const room = await this.roomAround(grid);
      const minW = cols * MIN_COL_W;
      const minH = rows * MIN_ROW_H;
      if (room.width < Math.max(minW, 80) || room.height < Math.max(minH, 40)) {
        await this.opLog(`size skipped: not even the minimum ${minW}x${minH} fits next to the other tables`);
        return "no room to resize";
      }
      const width = clampTo(Math.min(rngInt(rng, 1, 18) * 40, Math.floor(room.width)), 80, 4000);
      const height = clampTo(Math.min(rngInt(rng, 1, 10) * 40, Math.floor(room.height)), 40, 4000);
      const wantW = Math.max(width, minW);
      const wantH = Math.max(height, minH);
      await this.setAndApply("ความกว้างรวม (px)", width);
      await this.setAndApply("ความสูงรวม (px)", height);
      const after = await this.live();
      const cells = liveCells(after, grid);
      const box = geometryOf(after, grid).box;
      if (!near(box[2], wantW, 1) || !near(box[3], wantH, 1)) {
        throw new Fail(
          "panel-size",
          `asked for ${width}×${height} on a ${cols}×${rows} grid (min ${wantW}×${wantH}), the grid is ${round(box[2])}×${round(box[3])}`,
          cells.map((el) => el.id),
        );
      }
      await this.opLog(`size ${width}x${height} -> ${round(box[2])}x${round(box[3])}`);
      return `size ${round(box[2])}×${round(box[3])}`;
    }

    if (name === "header") {
      const before = liveCells(scene, grid)[0].customData.headerRow;
      await page.toggleHeader();
      await page.update();
      const after = await this.live();
      const cells = liveCells(after, grid);
      const flag = cells[0]?.customData.headerRow;
      if (flag === before) throw new Fail("panel-header", `header toggle did not change the grid (still ${flag})`, cells.map((el) => el.id));
      await this.opLog(`header ${before} -> ${flag}`);
      return `header ${before} → ${flag}`;
    }

    if (name === "color") {
      const before = liveCells(scene, grid)[0].customData.color;
      const next = pick(rng, COLORS.filter((name) => name !== before));
      await page.selectColor(next);
      await page.update();
      const after = await this.live();
      const colors = new Set(liveCells(after, grid).map((el) => el.customData.color));
      if (colors.size !== 1 || !colors.has(next)) {
        throw new Fail("panel-color", `asked for ${next}, cells say ${[...colors].join(",")}`, liveCells(after, grid).map((el) => el.id));
      }
      await this.opLog(`color ${before} -> ${next}`);
      return `color ${before} → ${next}`;
    }

    if (name === "title") {
      const value = `soak title ${rngInt(rng, 1, 99)}`;
      await page.setTitle(value);
      await page.update();
      const after = await this.live();
      const heads = after.filter((el) => el.type === "text" && el.customData?.grid === grid && el.customData?.title);
      if (heads.length !== 1) {
        throw new Fail("heading-count", `grid ${grid} has ${heads.length} heading texts`, heads.map((el) => el.id));
      }
      if (heads[0].text !== value) {
        throw new Fail("heading-text", `heading stayed "${heads[0].text}", the panel asked for "${value}"`, [heads[0].id]);
      }
      await this.opLog(`title "${value}"`);
      return `title "${value}"`;
    }

    if (name === "grow-row" || name === "grow-col") {
      const axis = name === "grow-row" ? "row" : "col";
      const before = info;
      const room = await this.roomAround(grid);
      const step = axis === "row" ? Math.round(before.box?.[3] / Math.max(1, before.rows)) : Math.round(before.box?.[2] / Math.max(1, before.cols));
      if ((axis === "row" ? room.height : room.width) < step) {
        await this.opLog(`grow ${axis} skipped: no room next to the other tables`);
        return "no room to grow";
      }
      await page.grow(axis);
      const after = await this.live();
      const cols = Math.max(...liveCells(after, grid).map((el) => el.customData.c)) + 1;
      const rows = Math.max(...liveCells(after, grid).map((el) => el.customData.r)) + 1;
      const expected = axis === "row" ? { rows: before.rows + 1, cols: before.cols } : { rows: before.rows, cols: before.cols + 1 };
      if (rows !== expected.rows || cols !== expected.cols) {
        throw new Fail(
          "grow",
          `+1 ${axis} from ${before.cols}×${before.rows} produced ${cols}×${rows}, expected ${expected.cols}×${expected.rows}`,
          liveCells(after, grid).map((el) => el.id),
        );
      }
      await this.opLog(`grow ${axis} ${before.cols}x${before.rows} -> ${cols}x${rows}`);
      return `+1 ${axis} → ${cols}×${rows}`;
    }

    throw new Fail("op-unknown", `unknown op ${name}`);
  }

  /** Set a panel field, make sure React kept the value, then press update. */
  async setAndApply(label, value) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.page.setField(label, value);
      if (Number(await this.page.fieldValue(label)) === value) break;
      await sleep(60);
    }
    await this.page.update();
  }

  /** Generic per-op bookkeeping: invariants, persistence, text preservation. */
  async afterOp(before, opIndex, opName) {
    // these ops may legitimately change what a cell or heading says; every other
    // op must keep it (that is the "text does not get lost" half of the report)
    const rewritesText = opName === "cell-text" || opName === "title" || opName === "undo" || opName === "redo";
    const scene = await this.page.settle();
    // overlapping tables are allowed once a person drags or grows one over another;
    // only a fresh insert must land clear of the others (checked by the insert op)
    const problems = checkScene(scene.elements);
    if (problems.length) throw new Fail(problems[0].code, problems[0].message, problems[0].ids);

    const persisted = await this.waitSaved(scene.elements);
    if (!persisted) {
      this.persistedWarnings += 1;
      const io = await this.page.ioStats();
      await this.opLog(
        `  ! board on disk did not catch up after op ${opIndex} ` +
          `(live ${scene.elements.length} els, sent ${JSON.stringify(io)}, net ${this.page.netTail()})`,
      );
    } else {
      const persistedProblems = checkScene(persisted);
      if (persistedProblems.length) {
        throw new Fail(
          `persisted-${persistedProblems[0].code}`,
          `the saved board is broken: ${persistedProblems[0].message}`,
          persistedProblems[0].ids,
        );
      }
    }

    // text a surviving cell already had must still be there
    if (rewritesText) return;
    const beforeText = textSlots(before.elements);
    const afterText = textSlots(scene.elements);
    const afterCells = cellSlots(scene.elements);
    for (const [slot, value] of beforeText) {
      if (!afterCells.has(slot)) continue; // the cell itself is gone, fine
      // A narrower cell legitimately re-wraps (and may end in "…"), so compare the
      // same squashed form the typing op uses instead of the raw string.
      if (squashText(afterText.get(slot) ?? null) !== squashText(value)) {
        throw new Fail(
          "text-lost",
          `cell ${slot} held ${JSON.stringify(value)} before this op and now holds ${JSON.stringify(afterText.get(slot) ?? null)}`,
          liveCells(scene.elements).filter((el) => `${el.customData.grid}|${el.customData.r}|${el.customData.c}` === slot).map((el) => el.id),
        );
      }
    }
    // the same for a grid's heading
    const beforeTitle = titleSlots(before.elements);
    const afterTitle = titleSlots(scene.elements);
    for (const [grid, slots] of beforeTitle) {
      if (!afterCells.size || !liveCells(scene.elements, grid).length) continue;
      for (const [slot, value] of Object.entries(slots)) {
        const now = afterTitle.get(grid)?.[slot];
        if (now !== value) {
          throw new Fail(
            "title-lost",
            `grid ${grid} ${slot} ${JSON.stringify(value)} became ${JSON.stringify(now ?? null)}`,
            liveCells(scene.elements, grid).map((el) => el.id),
          );
        }
      }
    }
  }

  async run() {
    await this.page.open();
    // op 0 is setup: put the first table on the board and select one cell
    await this.page.insert();
    let elements = await this.live();
    let grid = gridIds(elements)[0];
    if (!grid) throw new Fail("setup", "the insert button produced no table");
    const cell = liveCells(elements, grid)[0];
    await this.page.clickCell(grid, cell.customData.r, cell.customData.c);
    await this.live();
    if (!(await this.page.selectedGrid())) throw new Fail("setup", "the first table cannot be selected");
    await this.opLog(`insert first table grid=${grid} ${JSON.stringify(geometryOf(elements, grid).box)}`);
    await this.afterOp({ elements: [] }, 0);

    const table = [];
    for (const [name, weight] of OPS) for (let i = 0; i < weight; i += 1) table.push(name);

    for (let index = 1; index <= this.ops; index += 1) {
      const name = pick(this.rng, table);
      const before = await this.page.settle();
      let description;
      try {
        description = await this.op(name);
      } catch (error) {
        if (error instanceof Fail) {
          error.op = { index, name, log: this.log.slice() };
          throw error;
        }
        error.op = { index, name, log: this.log.slice() };
        throw error;
      }
      try {
        await this.afterOp(before, index, name);
      } catch (error) {
        error.op = error.op || { index, name, log: this.log.slice() };
        throw error;
      }
      if (!quiet) process.stderr.write(`  ${String(index).padStart(2, "0")} ${name.padEnd(12)} ${description}\n`);
    }
    return { ops: this.ops, grids: gridIds(await this.live()).length };
  }
}

/* ---------------------------------------------------------------- report */

async function reportFailure({ seed, error, page, ops }) {
  const op = error.op || { index: 0, name: "setup", log: [] };
  const code = error instanceof Fail ? error.code : "op-error";
  const lines = [];
  lines.push("");
  lines.push(`FAIL seed ${seed} · op ${op.index} (${op.name}) · ${code}`);
  lines.push(`  ${error.message}`);
  if (error.stack && !(error instanceof Fail)) lines.push(String(error.stack).split("\n").slice(1, 4).join("\n"));
  lines.push("");
  lines.push("op log:");
  for (const [i, line] of ops.log.entries()) lines.push(`  ${String(i).padStart(2, "0")} ${line}`);
  lines.push("");

  let elements = [];
  try {
    elements = (await page.snapshot()).elements;
  } catch {
    /* the page may be wedged; the log is still useful */
  }
  const ids = new Set(error.ids || []);
  // a whole grid is the useful unit: a row that disagrees with itself only makes
  // sense next to its siblings, and a stray cell is only visible beside the rest
  const grids = new Set(elements.filter((el) => ids.has(el.id) && el.customData?.grid).map((el) => el.customData.grid));
  for (const el of elements) {
    if (el.customData?.grid && grids.has(el.customData.grid)) ids.add(el.id);
  }
  const relevant = ids.size
    ? elements.filter((el) => ids.has(el.id) || ids.has(el.containerId))
    : elements.filter((el) => el.customData?.grid || el.containerId);
  lines.push(`elements (${relevant.length} of ${elements.length}):`);
  lines.push(JSON.stringify(relevant.slice(0, 60).map(compact), null, 1));

  const consoleErrors = page.cdp.consoleErrors.slice(-6);
  if (consoleErrors.length) {
    lines.push("");
    lines.push("page errors:");
    for (const text of consoleErrors) lines.push(`  ${text.split("\n")[0]}`);
  }

  const file = path.join(FAIL_DIR, `fail-${seed}-${op.index}.png`);
  try {
    await mkdir(FAIL_DIR, { recursive: true });
    await page.cdp.screenshot(file);
    lines.push("");
    lines.push(`screenshot: ${file}`);
  } catch (shotError) {
    lines.push(`screenshot failed: ${shotError.message}`);
  }
  console.log(lines.join("\n"));
  return { file, code, op: op.index, name: op.name, message: error.message };
}


/* ----------------------------------------------------------------- probe */

/**
 * Micro-scenario that answers "the canvas went blank after Cmd+Z": prints what
 * the page thinks it has (api scene, panel, notes) at every step.
 */
/** One line: live cells per grid, their meta variants, and how many are deleted. */
/** Column widths / row heights of every grid on the board, in px. */
function tracks(elements) {
  const out = [];
  for (const gid of gridIds(elements)) {
    const geom = geometryOf(elements, gid);
    out.push({ grid: gid, box: geom.box, cols: geom.cols.map(([, w]) => round(w)), rows: geom.rows.map(([, h]) => round(h)) });
  }
  return out;
}

function summarise(elements) {
  const cells = liveCells(elements);
  const variants = new Map();
  for (const cell of cells) {
    const cd = cell.customData;
    const key = `${cd.grid}:${cd.rows}x${cd.cols}@${cd.color}`;
    variants.set(key, (variants.get(key) || 0) + 1);
  }
  const deleted = (elements || []).filter((el) => el.isDeleted).length;
  return `${cells.length} live cells (${deleted} deleted) ${JSON.stringify([...variants.entries()])}`;
}

// A/B experiment: an element dropped by omitting it from updateScene's array vs
// an element explicitly flagged isDeleted in the same update. Which of the two
// removals does one Cmd+Z bring back?
// A/B experiment: an element dropped by omitting it from updateScene's array vs
// an element explicitly flagged isDeleted in the same update. Which of the two
// removals survives, and what does one undo bring back?
async function probeUndoAB(page) {
  const api = `window.__boardsApi`;
  const read = async (label) => {
    const data = await page.cdp.evaluate(`(() => {
      const api = ${api};
      const all = api.getSceneElementsIncludingDeleted();
      const mine = all.filter((el) => el.customData && el.customData.probe);
      return {
        total: all.length,
        live: mine.filter((el) => !el.isDeleted).map((el) => el.customData.probe),
        deleted: mine.filter((el) => el.isDeleted).map((el) => el.customData.probe),
        history: api.history && typeof api.history.undo === "function" ? "api" : "none",
      };
    })()`);
    console.log(`  AB ${label.padEnd(22)} ${JSON.stringify(data)}`);
    return data;
  };
  const undo = async () => {
    const via = await page.cdp.evaluate(`(() => {
      const h = window.__boardsApi.history;
      if (h && typeof h.undo === "function") { h.undo(); return "api"; }
      return "keys";
    })()`);
    if (via !== "api") await page.undo();
    await sleep(200);
  };
  const reset = async () => {
    await page.cdp.evaluate(`(() => {
      const api = ${api};
      api.updateScene({ elements: api.getSceneElements().filter((el) => !(el.customData && el.customData.probe)) });
    })()`);
    await sleep(80);
  };
  const setup = async () => {
    await page.cdp.evaluate(`(() => {
      const api = ${api};
      const keep = api.getSceneElements().filter((el) => !(el.customData && el.customData.probe));
      const tpl = keep.find(
        (el) => el.type === "rectangle" && Number.isFinite(el.customData?.r) && Number.isFinite(el.customData?.c),
      );
      const make = (name, x) => ({
        ...tpl,
        id: "ab-" + name + "-" + Math.random().toString(36).slice(2, 6),
        type: "rectangle",
        x,
        y: 3000,
        width: 100,
        height: 40,
        angle: 0,
        groupIds: [],
        boundElements: [],
        isDeleted: false,
        customData: { probe: name },
      });
      const a = make("a", 3000);
      const b = make("b", 3200);
      window.__ab = { a, b };
      api.updateScene({ elements: [...keep, a, b], captureUpdate: "IMMEDIATELY" });
    })()`);
    await sleep(150);
  };

  // A: drop b by omission (what applyGrid does today)
  await setup();
  await read("A setup");
  await page.cdp.evaluate(`(() => {
    const api = ${api};
    api.updateScene({
      elements: api.getSceneElements().filter((el) => el.id !== window.__ab.b.id),
      captureUpdate: "IMMEDIATELY",
    });
  })()`);
  await sleep(150);
  await read("A after omit");
  await undo();
  await read("A after undo");

  // B: drop b by marking it isDeleted in the same update
  await reset();
  await setup();
  await read("B setup");
  await page.cdp.evaluate(`(() => {
    const api = ${api};
    const live = api.getSceneElements();
    const b = live.find((el) => el.id === window.__ab.b.id);
    api.updateScene({
      elements: [...live.filter((el) => el.id !== window.__ab.b.id), { ...b, isDeleted: true }],
      captureUpdate: "IMMEDIATELY",
    });
  })()`);
  await sleep(150);
  await read("B after flag");
  await undo();
  await read("B after undo");
  await undo();
  await read("B after 2nd undo");
  await reset();
}

async function probeStep(page, label) {
  const data = await page.cdp.evaluate(`(() => {
    const api = window.__boardsApi;
    const state = api.getAppState();
    return {
      elements: api.getSceneElements().length,
      includingDeleted: (api.getSceneElementsIncludingDeleted?.() || []).length,
      selected: Object.keys(state.selectedElementIds || {}).length,
      view: [Math.round(state.scrollX), Math.round(state.scrollY), state.zoom?.value],
      note: document.querySelector(".panel .note")?.textContent ?? null,
      sizing: !!document.querySelector(".grid-sizing"),
      bodies: (window.__soakBodies || []).slice(-4).map((b) => b.elements),
      io: window.__soakIO || null,
    };
  })()`);
  const elements = (await page.snapshot()).elements;
  console.log(`  ${label.padEnd(18)} ${JSON.stringify(data)}`);
  console.log(`  ${"".padEnd(18)} ${summarise(elements)}`);
  console.log(`  ${"".padEnd(18)} tracks ${JSON.stringify(tracks(elements))}`);
  return data;
}

async function runProbe(opts) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "probe-data-"));
  const galleryDir = await mkdtemp(path.join(os.tmpdir(), "probe-gallery-"));
  let server = null;
  let chrome = null;
  try {
    server = await startServer({ dataDir, galleryDir, appDir: APP_DIST });
    chrome = await launchChrome({ headed: opts.headed });
    await chrome.cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1600,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const created = await fetchJson(`${server.base}/api/boards`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "probe" }),
    });
    const page = new Page(chrome.cdp, server.base, created.body.id);
    await page.open();
    await probeStep(page, "opened");
    await page.insert();
    await sleep(400);
    await probeStep(page, "inserted");
    const elements = (await page.settle()).elements;
    const grid = gridIds(elements)[0];
    const cell = liveCells(elements, grid)[0];
    await page.clickCell(grid, cell.customData.r, cell.customData.c);
    await sleep(200);
    await probeStep(page, "cell clicked");
    await page.undo();
    await sleep(400);
    await probeStep(page, "after undo");
    await page.redo();
    await sleep(400);
    await probeStep(page, "after redo");
    await page.settle();

    // scenario: the same table edited a few times, then undone step by step
    await page.insert();
    await sleep(300);
    await page.setField("จำนวนคอลัมน์", 5);
    await page.update();
    await sleep(250);
    await probeStep(page, "cols 3->5");
    await page.setField("จำนวนคอลัมน์", 3);
    await page.update();
    await sleep(250);
    await probeStep(page, "cols 5->3");
    await page.undo();
    await probeStep(page, "undo 1");
    await page.undo();
    await probeStep(page, "undo 2");
    await page.undo();
    await probeStep(page, "undo 3");
    await page.redo();
    await probeStep(page, "redo 1");
    await page.redo();
    await probeStep(page, "redo 2");

    // scenario: the seed-1 head of the soak — column drag, undo, redo, then a
    // total width the grid cannot honour
    await page.setField("จำนวนคอลัมน์", 3);
    await page.update();
    await sleep(250);
    await probeStep(page, "cols back to 3");
    const grid3 = gridIds((await page.settle()).elements)[0];
    const cell3 = liveCells((await page.settle()).elements, grid3)[0];
    await page.clickCell(grid3, cell3.customData.r, cell3.customData.c);
    await sleep(150);
    await page.dragSlider("col", -1037);
    await probeStep(page, "col slider");
    await page.undo();
    await probeStep(page, "col undo");
    await page.redo();
    await probeStep(page, "col redo");
    await page.setField("ความกว้างรวม (px)", 80);
    await page.update();
    await sleep(300);
    await probeStep(page, "width 80");

    // A/B: is "drop an element by omitting it from updateScene" undoable?
    await probeUndoAB(page);
    const file = path.join(FAIL_DIR, "probe.png");
    await page.cdp.screenshot(file);
    console.log(`screenshot: ${file}`);
    console.log(`net: ${page.netTail(14)}`);
  } finally {
    if (chrome?.proc) chrome.proc.kill("SIGKILL");
    if (server?.proc) server.proc.kill("SIGKILL");
    if (!opts.keep) {
      await rm(dataDir, { recursive: true, force: true });
      await rm(galleryDir, { recursive: true, force: true });
    }
  }
}

/* ------------------------------------------------------------------ main */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  quiet = opts.json;
  if (opts.probe) {
    await runProbe(opts);
    return;
  }
  if (!opts.json) console.log(`soak-table: seeds ${opts.seeds.join(",")} × ${opts.ops} ops`);
  await mkdir(FAIL_DIR, { recursive: true });

  const dataDir = await mkdtemp(path.join(os.tmpdir(), "soak-data-"));
  const galleryDir = await mkdtemp(path.join(os.tmpdir(), "soak-gallery-"));
  let server = null;
  let chrome = null;
  const seeds = [];
  let allOk = true;

  try {
    server = await startServer({ dataDir, galleryDir, appDir: APP_DIST });
    chrome = await launchChrome({ headed: opts.headed });
    await chrome.cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1600,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });

    for (const seed of opts.seeds) {
      const name = `soak-${seed}-${Date.now().toString(36)}`;
      const created = await fetchJson(`${server.base}/api/boards`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const boardId = created.body?.id;
      if (!boardId) throw new Error(`cannot create a board: ${created.status} ${JSON.stringify(created.body)}`);

      const page = new Page(chrome.cdp, server.base, boardId);
      const soak = new Soak({ page, base: server.base, boardId, seed, ops: opts.ops });
      const started = Date.now();
      let result;
      try {
        const summary = await soak.run();
        result = { seed, ok: true, ops: summary.ops, grids: summary.grids, ms: Date.now() - started };
        if (!opts.json) console.log(`seed ${seed}: clean (${summary.ops} ops, ${summary.grids} grids, ${result.ms}ms)`);
      } catch (error) {
        allOk = false;
        const failure = await reportFailure({ seed, error, page, ops: soak });
        result = {
          seed,
          ok: false,
          ops: soak.ops,
          atOp: failure.op,
          opName: failure.name,
          invariant: failure.code,
          message: failure.message,
          screenshot: failure.file,
          ms: Date.now() - started,
        };
        if (!opts.json) console.log(`seed ${seed}: FAILED at op ${failure.op} (${failure.name}) — ${failure.code}`);
      }
      seeds.push(result);
      await fetchJson(`${server.base}/api/boards/${encodeURIComponent(boardId)}`, { method: "DELETE" }).catch(() => {});
    }
  } finally {
    chrome?.cdp?.ws?.close();
    chrome?.proc?.kill("SIGKILL");
    server?.proc?.kill("SIGKILL");
    if (!opts.keep) {
      await rm(dataDir, { recursive: true, force: true }).catch(() => {});
      await rm(galleryDir, { recursive: true, force: true }).catch(() => {});
      if (chrome?.profile) await rm(chrome.profile, { recursive: true, force: true }).catch(() => {});
    } else {
      console.log(`kept data dir ${dataDir}`);
    }
  }

  const summary = {
    ok: allOk,
    ops: opts.ops,
    seedCount: seeds.length,
    seeds,
    pass: seeds.filter((s) => s.ok).length,
    fail: seeds.filter((s) => !s.ok).length,
  };
  if (!opts.json) {
    console.log(
      `${allOk ? "PASS" : "FAIL"}  ${summary.pass}/${summary.seedCount} seeds clean · ${opts.ops} ops each`,
    );
  }
  console.log(`SOAK_JSON ${JSON.stringify(summary)}`);
  process.exit(allOk ? 0 : 1);
}

main().catch((error) => {
  console.error(`soak-table crashed: ${error.stack || error.message}`);
  process.exit(2);
});
