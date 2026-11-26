#!/usr/bin/env node
/**
 * e2e-catalog.mjs — real-browser contract test for the board catalogue page.
 *
 * The harness boots its own world so it never touches the real catalogue:
 *   - a throwaway DATA_DIR with fixture boards and groups,
 *   - a throwaway GALLERY_DIR built from that data with gallery/build.mjs,
 *   - app/server.mjs on an OS-assigned port,
 *   - headless Chrome (CDP over the WebSocket built into Node 22+).
 *
 * It then checks the catalogue's view modes (card / list / bento), the
 * collapsible group bar, and the behaviour that predates them (search, group
 * sections, section folding, console errors).  Everything is reported as
 * `PASS <name> — <evidence>` / `FAIL <name> — <reason>` and the process exits
 * non-zero as soon as one check fails.
 *
 * Usage:
 *   node scripts/e2e-catalog.mjs            run, clean up, exit 0/1
 *   node scripts/e2e-catalog.mjs --keep     leave server + Chrome running
 *
 * The server imports `ws` from app/node_modules, so run `npm ci` in app/ once
 * (this script deliberately adds no dependencies itself).
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SERVER = path.join(ROOT, "app", "server.mjs");
const BUILD = path.join(ROOT, "gallery", "build.mjs");
const CHROME =
  process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const KEEP = process.argv.includes("--keep");
const TMP_BASE = process.platform === "win32" ? os.tmpdir() : "/tmp";
const TMP_ROOT = path.join(TMP_BASE, `e2e-catalog-${process.pid}`);
const SHOTS_DIR = path.join(TMP_BASE, "e2e-catalog");
const ALLOWED_WEIGHTS = ["small", "wide", "tall", "large"];
const SEARCH_TERM = "alpha";

// ---------------------------------------------------------------------------
// Fixtures: eight boards across three groups.  Weights follow the catalogue
// rule (w*h area and element count) so the grid has large, wide, tall and
// small cards to compare against each other.
// ---------------------------------------------------------------------------

const GROUPS = [
  { key: "work", id: "grp_aaaaaaaa", name: "Work", color: "violet" },
  { key: "personal", id: "grp_bbbbbbbb", name: "Personal", color: "blue" },
  { key: "archive", id: "grp_cccccccc", name: "Archive", color: "teal" },
];

const SUBTITLE = "Catalogue fixture board for the e2e run";

function rect(id, x, y, width, height) {
  return {
    id,
    type: "rectangle",
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: 1,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
  };
}

/** `count` rectangles in a grid, used to hit the element-count weight rules. */
function rectGrid(count, columns, cellWidth, cellHeight, gap) {
  const elements = [];
  for (let i = 0; i < count; i += 1) {
    const column = i % columns;
    const row = Math.floor(i / columns);
    elements.push(
      rect(`el-${i}`, column * (cellWidth + gap), row * (cellHeight + gap), cellWidth, cellHeight),
    );
  }
  return elements;
}

function rectRow(count, width, height, gap) {
  return Array.from({ length: count }, (_, i) => rect(`el-${i}`, i * (width + gap), 0, width, height));
}

const BOARDS = [
  {
    id: "alpha-large",
    title: "Alpha dashboard",
    group: "work",
    elements: rectGrid(60, 10, 30, 12, 6), // 60 elements -> large
  },
  {
    id: "beta-wide",
    title: "Beta roadmap",
    group: "work",
    elements: rectGrid(25, 10, 34, 14, 8), // 25 elements -> wide
  },
  {
    id: "delta-small",
    title: "Delta notes",
    group: "work",
    elements: rectRow(3, 220, 160, 10), // small
  },
  {
    id: "gamma-tall",
    title: "Gamma tower",
    group: "personal",
    elements: [rect("el-0", 0, 0, 400, 900)], // tall
  },
  {
    id: "epsilon-small",
    title: "Epsilon sketch",
    group: "personal",
    elements: rectRow(2, 200, 140, 10), // small
  },
  {
    id: "zeta-large",
    title: "Zeta canvas",
    group: "personal",
    elements: [rect("el-0", 0, 0, 1300, 1200)], // 1.56M area -> large
  },
  {
    id: "eta-wide",
    title: "Eta grid",
    group: "archive",
    elements: [rect("el-0", 0, 0, 800, 820)], // 656k area -> wide
  },
  {
    id: "theta-small",
    title: "Theta memo",
    group: "archive",
    elements: rectGrid(4, 2, 280, 180, 10), // small
  },
];

// ---------------------------------------------------------------------------
// Tiny result collector / output contract.
// ---------------------------------------------------------------------------

const results = [];
const shots = [];
let server = null;
let chrome = null;
let cdp = null;
let tmpRoot = null;
let cleaned = false;
let foldedHeaderHeight = null;

function check(name, ok, detail = "") {
  const clean = String(detail ?? "")
    .replace(/\s+/g, " ")
    .trim();
  results.push({ name, ok: Boolean(ok), detail: clean });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${clean ? ` — ${clean}` : ""}`);
  return Boolean(ok);
}

async function runCheck(name, fn) {
  try {
    const outcome = await fn();
    if (outcome && typeof outcome === "object" && "ok" in outcome) {
      check(name, outcome.ok, outcome.detail ?? "");
    } else {
      check(name, Boolean(outcome));
    }
  } catch (error) {
    check(name, false, error?.message || String(error));
  }
}

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const tail = (text, lines = 8) =>
  String(text || "")
    .trim()
    .split("\n")
    .slice(-lines)
    .join(" | ");

function supervise(child) {
  const state = { child, out: "", err: "", exited: false, code: null, signal: null };
  const append = (current, chunk) => {
    const next = current + String(chunk);
    return next.length > 20000 ? next.slice(-20000) : next;
  };
  if (child.stdout) child.stdout.on("data", (chunk) => (state.out = append(state.out, chunk)));
  if (child.stderr) child.stderr.on("data", (chunk) => (state.err = append(state.err, chunk)));
  state.exit = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      state.exited = true;
      state.code = code;
      state.signal = signal;
      resolve();
    });
    child.once("error", (error) => {
      state.err = append(state.err, `${error.message}\n`);
      if (!state.exited) {
        state.exited = true;
        state.code = -1;
        resolve();
      }
    });
  });
  return state;
}

async function stopChild(state, graceMs = 3000) {
  if (!state || state.exited) return;
  try {
    state.child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  const graceful = await Promise.race([state.exit.then(() => true), sleep(graceMs).then(() => false)]);
  if (!graceful && !state.exited) {
    try {
      state.child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    await Promise.race([state.exit, sleep(1500)]);
  }
}

async function freePorts(count) {
  const listeners = [];
  const ports = [];
  for (let i = 0; i < count; i += 1) {
    const listener = net.createServer();
    await new Promise((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", resolve);
    });
    ports.push(listener.address().port);
    listeners.push(listener);
  }
  await Promise.all(
    listeners.map(
      (listener) =>
        new Promise((resolve) => {
          listener.close(resolve);
        }),
    ),
  );
  return ports;
}

async function waitForHttp(url, { timeout = 20000, accept = (res) => res.ok } = {}) {
  const deadline = Date.now() + timeout;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (accept(response)) return response;
      last = `HTTP ${response.status}`;
      await response.body?.cancel?.();
    } catch (error) {
      last = error.message;
    }
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${url} (${last})`);
}

function runCommand(command, args, { env = process.env, timeout = 120000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* noop */
      }
    }, timeout);
    child.stdout.on("data", (chunk) => (out += String(chunk)));
    child.stderr.on("data", (chunk) => (err += String(chunk)));
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: `${err}${error.message}` });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

// ---------------------------------------------------------------------------
// Fixture seeding and catalogue build.
// ---------------------------------------------------------------------------

async function seedFixtureData(dataDir) {
  await mkdir(dataDir, { recursive: true });
  const now = Date.now();
  await writeFile(
    path.join(dataDir, ".groups.json"),
    JSON.stringify(
      {
        version: 1,
        groups: GROUPS.map((group, index) => ({
          id: group.id,
          name: group.name,
          color: group.color,
          createdAt: new Date(now - (index + 1) * 86400000).toISOString(),
          updatedAt: new Date(now - (index + 1) * 86400000).toISOString(),
        })),
      },
      null,
      2,
    ),
  );

  for (const [index, board] of BOARDS.entries()) {
    const group = GROUPS.find((candidate) => candidate.key === board.group);
    if (!group) throw new Error(`fixture board ${board.id} names unknown group ${board.group}`);
    const boardDir = path.join(dataDir, board.id);
    await mkdir(boardDir, { recursive: true });
    const scene = {
      type: "excalidraw",
      version: 2,
      source: "scripts/e2e-catalog.mjs",
      elements: board.elements,
      appState: { viewBackgroundColor: "#ffffff" },
      files: {},
    };
    const scenePath = path.join(boardDir, "scene.excalidraw");
    await writeFile(scenePath, JSON.stringify(scene));
    await writeFile(
      path.join(boardDir, "meta.json"),
      JSON.stringify(
        {
          title: board.title,
          subtitle: SUBTITLE,
          tags: ["e2e", "fixture"],
          groupIds: [group.id],
          groupId: group.id,
        },
        null,
        2,
      ),
    );
    const stamp = new Date(now - index * 60000);
    await utimes(scenePath, stamp, stamp).catch(() => {});
  }
}

async function buildCatalogue(dataDir, galleryDir) {
  await mkdir(galleryDir, { recursive: true });
  const result = await runCommand(process.execPath, [BUILD, "--no-render"], {
    env: { ...process.env, SCENES_DIR: dataDir, SITE_DIR: galleryDir },
    timeout: 120000,
  });
  const index = path.join(galleryDir, "index.html");
  const ok = result.code === 0 && existsSync(index);
  return { ok, result, index };
}

// ---------------------------------------------------------------------------
// Server + Chrome + CDP.
// ---------------------------------------------------------------------------

async function bootServer({ port, dataDir, galleryDir }) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      GALLERY_DIR: galleryDir,
      GALLERY_BUILD: BUILD,
      APP_DIR: path.join(ROOT, "app", "dist"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const state = supervise(child);
  server = state;
  try {
    const response = await waitForHttp(`http://127.0.0.1:${port}/api/boards`, { timeout: 20000 });
    const body = await response.json();
    return {
      state,
      url: `http://127.0.0.1:${port}`,
      boards: Array.isArray(body.boards) ? body.boards : [],
    };
  } catch (error) {
    const detail = state.exited
      ? `server exited (code ${state.code})`
      : error.message;
    throw new Error(`${detail}; log: ${tail(state.err || state.out) || "(empty)"}`);
  }
}

async function findPageTarget(port) {
  const deadline = Date.now() + 15000;
  let last = "no target";
  while (Date.now() < deadline) {
    if (chrome?.exited) throw new Error(`Chrome exited (code ${chrome.code}); profile ${TMP_ROOT}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(1500),
      });
      const targets = await response.json();
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page) return page;
      last = `${targets.length} target(s), none a page`;
    } catch (error) {
      last = error.message;
    }
    await sleep(150);
  }
  throw new Error(`no Chrome page target on port ${port} (${last})`);
}

async function bootChrome(port, profileDir) {
  if (!existsSync(CHROME)) {
    throw new Error(`${CHROME} not found (set CHROME=/path/to/chrome)`);
  }
  const child = spawn(
    CHROME,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--mute-audio",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      "--window-size=1440,900",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const state = supervise(child);
  chrome = state;
  const target = await findPageTarget(port);
  const connection = await CDP.connect(target.webSocketDebuggerUrl);
  cdp = connection;
  await connection.send("Page.enable");
  await connection.send("Runtime.enable");
  await connection.send("Log.enable");
  await connection.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await connection.send("Page.bringToFront");
  await connection.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  return connection;
}

class CDP {
  static async connect(url) {
    if (typeof WebSocket === "undefined") {
      throw new Error("Node 22+ with the built-in WebSocket is required");
    }
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out opening the CDP socket")), 10000);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("CDP socket error"));
        },
        { once: true },
      );
    });
    return new CDP(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.closed = false;
    this.errors = [];
    socket.addEventListener("message", (event) => this.onMessage(event.data));
    socket.addEventListener("close", () => {
      this.closed = true;
      for (const entry of this.pending.values()) entry.reject(new Error("CDP connection closed"));
      this.pending.clear();
    });
  }

  onMessage(raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
    } catch {
      return;
    }
    if (message.id && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`));
      else entry.resolve(message.result);
      return;
    }
    if (message.method === "Runtime.exceptionThrown") {
      const details = message.params?.exceptionDetails;
      this.pushError(
        details?.exception?.description || details?.text || "uncaught exception in page",
      );
    } else if (message.method === "Runtime.consoleAPICalled" && message.params?.type === "error") {
      const args = (message.params.args || []).map(
        (arg) => arg.value ?? arg.description ?? arg.preview?.description ?? arg.type,
      );
      this.pushError(args.filter(Boolean).join(" "));
    } else if (message.method === "Log.entryAdded" && message.params?.entry?.level === "error") {
      const entry = message.params.entry;
      this.pushError(`${entry.text}${entry.url ? ` (${entry.url})` : ""}`);
    }
  }

  pushError(text) {
    const clean = String(text).replace(/\s+/g, " ").trim().slice(0, 1500);
    if (clean && !this.errors.includes(clean)) this.errors.push(clean);
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error(`CDP is closed; cannot send ${method}`));
    const id = (this.nextId += 1);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, 20000);
      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.close();
    } catch {
      /* noop */
    }
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      const text = details.exception?.description || details.text || "evaluation failed";
      throw new Error(String(text).split("\n")[0]);
    }
    return result.result?.value;
  }

  async waitFor(expression, { timeout = 5000, interval = 100, label = expression } = {}) {
    const deadline = Date.now() + timeout;
    let last;
    for (;;) {
      try {
        const value = await this.evaluate(expression);
        if (value) return value;
        last = value;
      } catch (error) {
        last = error.message;
      }
      if (Date.now() >= deadline) {
        const suffix = last === undefined ? "" : ` (last: ${JSON.stringify(last)})`;
        throw new Error(`timed out after ${timeout}ms waiting for ${label}${suffix}`);
      }
      await sleep(interval);
    }
  }

  async click(selector) {
    const quoted = JSON.stringify(selector);
    const found = await this.evaluate(`(() => {
      const el = document.querySelector(${quoted});
      if (!el) return false;
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      return true;
    })()`);
    if (!found) throw new Error(`${selector} not found`);
    await sleep(80);
    const box = await this.evaluate(`(() => {
      const el = document.querySelector(${quoted});
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || rect.width === 0 || rect.height === 0) {
        return null;
      }
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    if (!box) throw new Error(`${selector} is not visible`);
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: box.x,
      y: box.y,
      button: "none",
      clickCount: 0,
    });
    await this.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: box.x,
      y: box.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: box.x,
      y: box.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    return box;
  }

  async settle() {
    await this.evaluate(
      "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))",
    );
  }

  async reload() {
    const timeOrigin = await this.evaluate("performance.timeOrigin");
    await this.send("Page.reload", { ignoreCache: true });
    await this.waitFor(
      `document.readyState === "complete" && Math.abs(performance.timeOrigin - ${Number(timeOrigin)}) > 0.001`,
      { timeout: 15000, label: "page reload" },
    );
  }

  async screenshot(name) {
    await mkdir(SHOTS_DIR, { recursive: true });
    const result = await this.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    const file = path.join(SHOTS_DIR, `${name}.png`);
    await writeFile(file, Buffer.from(result.data, "base64"));
    shots.push(file);
    return file;
  }
}

// ---------------------------------------------------------------------------
// Page-level readers.
// ---------------------------------------------------------------------------

const VISIBLE_CARDS = `(() => [...document.querySelectorAll(".card")].filter((el) => el.getClientRects().length > 0).length)()`;

async function waitReady() {
  await cdp.waitFor('document.readyState === "complete"', { timeout: 15000, label: "document ready" });
  await cdp.waitFor(
    `document.querySelectorAll(".board-section").length >= 3 && document.querySelectorAll("#group-chips .chip").length >= 4`,
    { timeout: 8000, label: "group sections and chips rendered" },
  );
  await cdp
    .waitFor(`(() => {
      const bar = document.getElementById("groupbar");
      return Boolean(bar) && !bar.hidden;
    })()`, { timeout: 4000, label: "group bar visible" })
    .catch(() => {});
}

async function countsState() {
  return cdp.evaluate(`(() => ({
    cards: document.querySelectorAll(".card").length,
    visibleCards: [...document.querySelectorAll(".card")].filter((el) => el.getClientRects().length > 0).length,
    sections: document.querySelectorAll(".board-section").length,
    chips: document.querySelectorAll("#group-chips .chip").length,
    groupbarHidden: document.getElementById("groupbar") ? document.getElementById("groupbar").hidden : null,
    title: document.title,
  }))()`);
}

async function viewState() {
  return cdp.evaluate(`(() => {
    const switcher = document.getElementById("view-switch");
    const buttons = switcher ? [...switcher.querySelectorAll(".view-btn")] : [];
    return {
      switchExists: Boolean(switcher),
      role: switcher ? switcher.getAttribute("role") : null,
      view: document.body.dataset.view ?? null,
      stored: localStorage.getItem("boards-view"),
      total: buttons.length,
      modes: buttons.map((button) => button.dataset.view ?? null),
      checked: buttons
        .filter((button) => button.getAttribute("aria-checked") === "true")
        .map((button) => button.dataset.view ?? null),
      radios: buttons.map((button) => button.getAttribute("role") ?? null),
    };
  })()`);
}

async function visibleCards() {
  return cdp.evaluate(`(() => {
    const cards = [];
    for (const el of document.querySelectorAll(".card")) {
      if (el.getClientRects().length === 0) continue;
      const rect = el.getBoundingClientRect();
      cards.push({
        slug: el.dataset.slug || "",
        weight: el.dataset.weight || null,
        section: el.closest(".board-section")?.dataset.group || "",
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
    }
    return cards;
  })()`);
}

async function cardLayoutInfo() {
  return cdp.evaluate(`(() => {
    const cards = [...document.querySelectorAll(".card")].filter((el) => el.getClientRects().length > 0);
    const grid = [...document.querySelectorAll(".grid")].find(
      (candidate) => candidate.getClientRects().length > 0 && candidate.querySelector(".card"),
    );
    const template = grid ? getComputedStyle(grid).gridTemplateColumns : null;
    const columns = template && template !== "none" ? template.trim().split(" ").filter(Boolean).length : 0;
    const rects = cards.map((el) => {
      const rect = el.getBoundingClientRect();
      return { width: Math.round(rect.width), height: Math.round(rect.height) };
    });
    return {
      cards: rects.length,
      columns,
      template,
      tall: rects.length > 0 && rects.every((rect) => rect.height > rect.width),
      minHeightOverWidth: rects.length
        ? Math.min(...rects.map((rect) => rect.height / rect.width))
        : null,
    };
  })()`);
}

async function weightInfo() {
  return cdp.evaluate(`(() => {
    const allowed = ${JSON.stringify(ALLOWED_WEIGHTS)};
    const cards = [...document.querySelectorAll(".card")].filter((el) => el.getClientRects().length > 0);
    const raw = cards.map((el) => el.dataset.weight ?? null);
    return {
      total: cards.length,
      present: raw.filter(Boolean).length,
      valid: raw.filter((weight) => allowed.includes(weight)).length,
      invalid: raw.filter((weight) => weight && !allowed.includes(weight)),
      values: [...new Set(raw.filter(Boolean))],
    };
  })()`);
}

async function barState() {
  return cdp.evaluate(`(() => {
    const header = document.querySelector("header");
    const groupbar = document.getElementById("groupbar");
    const toggle = document.getElementById("bar-toggle");
    const search = document.getElementById("q");
    const groupRect = groupbar ? groupbar.getBoundingClientRect() : null;
    const searchRect = search ? search.getBoundingClientRect() : null;
    const groupStyle = groupbar ? getComputedStyle(groupbar) : null;
    const searchStyle = search ? getComputedStyle(search) : null;
    return {
      headerExists: Boolean(header),
      dataBar: header ? header.getAttribute("data-bar") : null,
      headerHeight: header ? Math.round(header.getBoundingClientRect().height) : null,
      groupbar: groupbar
        ? {
            hidden: groupbar.hidden,
            display: groupStyle.display,
            visibility: groupStyle.visibility,
            width: Math.round(groupRect.width),
            height: Math.round(groupRect.height),
          }
        : null,
      toggle: toggle
        ? {
            exists: true,
            ariaControls: toggle.getAttribute("aria-controls"),
            ariaExpanded: toggle.getAttribute("aria-expanded"),
            dataFilter: toggle.dataset.filter ?? null,
          }
        : { exists: false },
      stored: localStorage.getItem("boards-bar"),
      search: search
        ? {
            width: Math.round(searchRect.width),
            height: Math.round(searchRect.height),
            display: searchStyle.display,
            visibility: searchStyle.visibility,
            opacity: searchStyle.opacity,
          }
        : null,
    };
  })()`);
}

function groupbarVisible(groupbar) {
  return Boolean(
    groupbar &&
      !groupbar.hidden &&
      groupbar.display !== "none" &&
      groupbar.visibility !== "hidden" &&
      groupbar.width > 0 &&
      groupbar.height > 0,
  );
}

function searchVisible(search) {
  return Boolean(
    search &&
      search.width > 0 &&
      search.height > 0 &&
      search.display !== "none" &&
      search.visibility !== "hidden" &&
      search.opacity !== "0",
  );
}

async function setSearch(term) {
  if (!(await cdp.evaluate('Boolean(document.getElementById("q"))'))) {
    throw new Error("#q search field not found");
  }
  await cdp.click("#q");
  await clearSearch();
  if (term) await cdp.send("Input.insertText", { text: term });
}

async function clearSearch() {
  await cdp.evaluate(`(() => {
    const input = document.getElementById("q");
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
}

async function switchView(mode) {
  const before = await viewState();
  if (!before.switchExists) throw new Error("#view-switch not found (view-mode feature missing)");
  const present = await cdp.evaluate(
    `Boolean(document.querySelector('#view-switch .view-btn[data-view="${mode}"]'))`,
  );
  if (!present) {
    throw new Error(
      `#view-switch has no [data-view="${mode}"] button (modes: ${before.modes.join(", ") || "none"})`,
    );
  }
  await cdp.click(`#view-switch .view-btn[data-view="${mode}"]`);
  await cdp.waitFor(`document.body.dataset.view === ${JSON.stringify(mode)}`, {
    timeout: 2500,
    label: `body data-view=${mode}`,
  });
  await cdp.settle();
  return viewState();
}

async function ensureBarExpanded() {
  const state = await barState();
  if (!state.toggle.exists) throw new Error("#bar-toggle not found (collapsible-bar feature missing)");
  if (state.toggle.ariaExpanded === "true" && groupbarVisible(state.groupbar)) return;
  await cdp.click("#bar-toggle");
  await cdp.waitFor(
    `document.getElementById("bar-toggle")?.getAttribute("aria-expanded") === "true"`,
    { timeout: 3000, label: "group bar expanded" },
  );
  await sleep(320);
}

async function takeShot(name) {
  try {
    await cdp.screenshot(name);
  } catch (error) {
    console.warn(`  screenshot ${name}.png failed: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// The checks.
// ---------------------------------------------------------------------------

async function main() {
  console.log("e2e-catalog — real-browser contract test for the board catalogue");
  console.log(`  repo   ${ROOT}`);
  console.log(`  temp   ${TMP_ROOT}`);

  await rm(TMP_ROOT, { recursive: true, force: true });
  tmpRoot = TMP_ROOT;
  await mkdir(tmpRoot, { recursive: true });
  const dataDir = path.join(tmpRoot, "data");
  const galleryDir = path.join(tmpRoot, "gallery");
  const profileDir = path.join(tmpRoot, "chrome-profile");
  await mkdir(dataDir, { recursive: true });
  await mkdir(galleryDir, { recursive: true });
  await mkdir(profileDir, { recursive: true });

  await seedFixtureData(dataDir);

  const catalogue = await buildCatalogue(dataDir, galleryDir);
  const buildOk = check(
    "catalogue build succeeds",
    catalogue.ok,
    catalogue.ok
      ? `${BOARDS.length} fixture boards → ${path.join(galleryDir, "index.html")}`
      : `exit ${catalogue.result.code}; ${tail(catalogue.result.err || catalogue.result.out)}`,
  );
  if (!buildOk) throw new Error("setup failed at the catalogue build");

  const ports = await freePorts(2);
  const [serverPort, chromePort] = ports;
  let booted;
  try {
    booted = await bootServer({ port: serverPort, dataDir, galleryDir });
  } catch (error) {
    check("server answers /api/boards on a free port", false, error.message);
    throw new Error("setup failed at the server");
  }
  check(
    "server answers /api/boards on a free port",
    true,
    `HTTP 200, ${booted.boards.length} boards at ${booted.url}`,
  );

  try {
    await bootChrome(chromePort, profileDir);
  } catch (error) {
    check("headless Chrome exposes a CDP page", false, error.message);
    throw new Error("setup failed at Chrome");
  }
  check(
    "headless Chrome exposes a CDP page",
    true,
    `${path.basename(CHROME)} on CDP port ${chromePort}`,
  );
  console.log(`  server ${booted.url}/gallery/`);
  console.log("");

  const pageUrl = `${booted.url}/gallery/`;
  await cdp.send("Page.navigate", { url: pageUrl });
  await cdp
    .waitFor(`location.href.startsWith(${JSON.stringify(pageUrl)}) && document.readyState === "complete"`, {
      timeout: 15000,
      label: "catalogue page load",
    })
    .catch(() => {});
  await waitReady().catch(() => {});

  await runCheck("catalogue page loads with fixture boards, sections and chips", async () => {
    const counts = await countsState();
    return {
      ok: counts.cards === 8 && counts.sections >= 3 && counts.chips >= 4,
      detail: `${counts.cards} cards, ${counts.sections} sections, ${counts.chips} chips, groupbar hidden=${counts.groupbarHidden}, title=${JSON.stringify(counts.title)}`,
    };
  });

  await runCheck("default view is the card grid", async () => {
    const state = await viewState();
    return {
      ok: state.view === "card",
      detail: `body data-view=${JSON.stringify(state.view)}`,
    };
  });

  await runCheck("view switch exposes three modes in a radiogroup", async () => {
    const state = await viewState();
    const expected = ["bento", "card", "list"];
    const modes = [...state.modes].sort();
    return {
      ok:
        state.switchExists &&
        state.role === "radiogroup" &&
        state.total === 3 &&
        JSON.stringify(modes) === JSON.stringify(expected) &&
        state.checked.length === 1,
      detail: state.switchExists
        ? `role=${state.role}, buttons=${state.total}, modes=${JSON.stringify(state.modes)}, aria-checked=${JSON.stringify(state.checked)}`
        : "#view-switch not found (view-mode feature missing)",
    };
  });

  await runCheck("card view keeps a multi-column grid of tall cards", async () => {
    const layout = await cardLayoutInfo();
    return {
      ok: layout.cards === 8 && layout.columns >= 2 && layout.tall,
      detail: `${layout.cards} cards, ${layout.columns} columns (${layout.template}), min height/width=${layout.minHeightOverWidth?.toFixed(2)}`,
    };
  });
  await takeShot("card-grid");

  await runCheck("every card carries a valid data-weight", async () => {
    const info = await weightInfo();
    const distinct = new Set(info.values);
    return {
      ok: info.total === 8 && info.present === 8 && info.valid === 8 && distinct.size >= 2,
      detail: `${info.present}/${info.total} tagged, values=${JSON.stringify([...distinct])}${
        info.invalid.length ? `, invalid=${JSON.stringify(info.invalid)}` : ""
      }`,
    };
  });

  await runCheck("search narrows the card grid", async () => {
    await setSearch(SEARCH_TERM);
    await cdp
      .waitFor(`${VISIBLE_CARDS} === 1`, { timeout: 4000, label: `search "${SEARCH_TERM}" → 1 card` })
      .catch(() => {});
    const found = await visibleCards();
    await clearSearch();
    await cdp
      .waitFor(`${VISIBLE_CARDS} === 8`, { timeout: 4000, label: "search cleared → 8 cards" })
      .catch(() => {});
    return {
      ok: found.length === 1 && found[0].slug === "alpha-large",
      detail: `${found.length} visible card(s): ${found.map((card) => card.slug).join(", ") || "none"}`,
    };
  });

  await runCheck("section folding still collapses its grid", async () => {
    const pick = await cdp.evaluate(`(() => {
      const sections = [...document.querySelectorAll(".board-section[data-group]")].filter(
        (section) => section.getClientRects().length > 0 && section.querySelector(".sect-toggle"),
      );
      if (!sections.length) return null;
      return { group: sections[0].dataset.group, collapsed: sections[0].dataset.collapsed ?? null };
    })()`);
    if (!pick) throw new Error("no .board-section with .sect-toggle found");
    const selector = `.board-section[data-group="${pick.group}"]`;
    const quoted = JSON.stringify(selector);
    const read = async () =>
      cdp.evaluate(`(() => {
        const section = document.querySelector(${quoted});
        const grid = section ? section.querySelector(".grid") : null;
        const rect = grid ? grid.getBoundingClientRect() : null;
        return {
          collapsed: section ? section.dataset.collapsed ?? null : null,
          display: grid ? getComputedStyle(grid).display : null,
          height: rect ? Math.round(rect.height) : null,
          expanded: section?.querySelector(".sect-toggle")?.getAttribute("aria-expanded") ?? null,
        };
      })()`);
    await cdp.click(`${selector} .sect-toggle`);
    await cdp.waitFor(`document.querySelector(${quoted})?.dataset.collapsed === "1"`, {
      timeout: 3000,
      label: "section collapsed",
    });
    await cdp.settle();
    const folded = await read();
    await cdp.click(`${selector} .sect-toggle`);
    await cdp.waitFor(`document.querySelector(${quoted})?.dataset.collapsed !== "1"`, {
      timeout: 3000,
      label: "section expanded",
    });
    await cdp.settle();
    const open = await read();
    return {
      ok:
        folded.collapsed === "1" &&
        (folded.display === "none" || folded.height === 0) &&
        folded.expanded === "false" &&
        open.display !== "none" &&
        open.height > 0,
      detail: `section ${pick.group}: folded display=${folded.display}, height=${folded.height}, aria=${folded.expanded}; open display=${open.display}, height=${open.height}`,
    };
  });

  await runCheck("list mode activates from the view switch", async () => {
    const state = await switchView("list");
    return {
      ok: state.view === "list" && state.stored === "list" && state.checked.join(",") === "list",
      detail: `body=${JSON.stringify(state.view)}, localStorage=${JSON.stringify(state.stored)}, aria-checked=${JSON.stringify(state.checked)}`,
    };
  });

  await runCheck("list mode renders one full-width row per card", async () => {
    await switchView("list");
    const cards = await visibleCards();
    const lefts = cards.map((card) => card.left);
    const spread = lefts.length ? Math.max(...lefts) - Math.min(...lefts) : null;
    const minRatio = cards.length ? Math.min(...cards.map((card) => card.width / card.height)) : null;
    const bySection = new Map();
    for (const card of cards) {
      if (!bySection.has(card.section)) bySection.set(card.section, []);
      bySection.get(card.section).push(card);
    }
    let onePerRow = true;
    for (const list of bySection.values()) {
      const tops = list.map((card) => card.top).sort((a, b) => a - b);
      for (let i = 1; i < tops.length; i += 1) {
        if (Math.abs(tops[i] - tops[i - 1]) <= 2) onePerRow = false;
      }
    }
    return {
      ok: cards.length === 8 && spread !== null && spread <= 2 && minRatio > 2.5 && onePerRow,
      detail: `${cards.length} rows, left spread=${spread}px, min width/height=${minRatio?.toFixed(2)}, one card per row=${onePerRow}`,
    };
  });
  await takeShot("list-rows");

  await runCheck("search also narrows the list view", async () => {
    await switchView("list");
    await setSearch(SEARCH_TERM);
    await cdp
      .waitFor(`${VISIBLE_CARDS} === 1`, { timeout: 4000, label: `search "${SEARCH_TERM}" in list view` })
      .catch(() => {});
    const found = await visibleCards();
    await clearSearch();
    await cdp
      .waitFor(`${VISIBLE_CARDS} === 8`, { timeout: 4000, label: "list search cleared" })
      .catch(() => {});
    return {
      ok: found.length === 1 && found[0].slug === "alpha-large",
      detail: `${found.length} visible row(s): ${found.map((card) => card.slug).join(", ") || "none"}`,
    };
  });

  await runCheck("bento mode activates from the view switch", async () => {
    const state = await switchView("bento");
    return {
      ok: state.view === "bento" && state.stored === "bento" && state.checked.join(",") === "bento",
      detail: `body=${JSON.stringify(state.view)}, localStorage=${JSON.stringify(state.stored)}, aria-checked=${JSON.stringify(state.checked)}`,
    };
  });

  await runCheck("bento makes wide cards about twice a small card", async () => {
    await switchView("bento");
    const cards = await visibleCards();
    const weights = [...new Set(cards.map((card) => card.weight).filter(Boolean))];
    const bySection = new Map();
    for (const card of cards) {
      if (!bySection.has(card.section)) bySection.set(card.section, []);
      bySection.get(card.section).push(card);
    }
    const findPair = (list) => {
      const wide = list.filter((card) => card.weight === "large" || card.weight === "wide");
      const small = list.filter((card) => card.weight === "small");
      for (const big of wide) {
        for (const tiny of small) {
          const ratio = big.width / tiny.width;
          if (ratio >= 1.8 && ratio <= 2.2) return { big, tiny, ratio };
        }
      }
      return null;
    };
    let pair = null;
    for (const list of bySection.values()) {
      pair = findPair(list);
      if (pair) break;
    }
    if (!pair) pair = findPair(cards);
    return {
      ok: cards.length === 8 && weights.length >= 2 && Boolean(pair),
      detail: pair
        ? `${weights.length} weights ${JSON.stringify(weights)}; ${pair.big.slug} ${pair.big.width}px / ${pair.tiny.slug} ${pair.tiny.width}px = ${pair.ratio.toFixed(2)}x`
        : `${cards.length} cards, weights ${JSON.stringify(weights)}; no large/wide card at 1.8–2.2x a small card`,
    };
  });
  await takeShot("bento-grid");

  await runCheck("view choice survives a reload", async () => {
    await switchView("bento");
    await cdp.reload();
    await waitReady();
    const state = await viewState();
    return {
      ok: state.view === "bento" && state.stored === "bento" && state.checked.join(",") === "bento",
      detail: `after reload body=${JSON.stringify(state.view)}, localStorage=${JSON.stringify(state.stored)}, aria-checked=${JSON.stringify(state.checked)}`,
    };
  });

  await runCheck("card mode comes back after bento", async () => {
    await switchView("card");
    const layout = await cardLayoutInfo();
    return {
      ok: layout.cards === 8 && layout.columns >= 2 && layout.tall,
      detail: `${layout.cards} cards, ${layout.columns} columns (${layout.template}), min height/width=${layout.minHeightOverWidth?.toFixed(2)}`,
    };
  });

  await runCheck("collapsible bar is present and starts open", async () => {
    const state = await barState();
    return {
      ok:
        state.headerExists &&
        state.toggle.exists &&
        state.toggle.ariaControls === "groupbar" &&
        state.toggle.ariaExpanded === "true" &&
        groupbarVisible(state.groupbar),
      detail: state.toggle.exists
        ? `#bar-toggle aria-controls=${JSON.stringify(state.toggle.ariaControls)}, aria-expanded=${JSON.stringify(state.toggle.ariaExpanded)}, groupbar visible=${groupbarVisible(state.groupbar)}, header=${state.headerHeight}px`
        : "#bar-toggle not found (collapsible-bar feature missing)",
    };
  });

  await runCheck("collapsing folds the header and hides the group bar", async () => {
    await ensureBarExpanded();
    const open = await barState();
    if (!open.headerExists) throw new Error("page header not found");
    const openHeight = open.headerHeight;
    await cdp.click("#bar-toggle");
    await cdp.waitFor(`document.querySelector("header")?.getAttribute("data-bar") === "folded"`, {
      timeout: 3000,
      label: 'header[data-bar="folded"]',
    });
    await sleep(320);
    const state = await barState();
    foldedHeaderHeight = state.headerHeight;
    const hidden = !groupbarVisible(state.groupbar);
    const heightDrop = openHeight !== null && state.headerHeight !== null && state.headerHeight < openHeight - 4;
    return {
      ok:
        hidden &&
        state.toggle.ariaExpanded === "false" &&
        state.stored === "folded" &&
        searchVisible(state.search) &&
        heightDrop,
      detail: `header ${openHeight}px→${state.headerHeight}px, data-bar=${JSON.stringify(state.dataBar)}, expanded=${JSON.stringify(state.toggle.ariaExpanded)}, storage=${JSON.stringify(state.stored)}, groupbar hidden=${hidden}, #q visible=${searchVisible(state.search)}`,
    };
  });
  await takeShot("folded-bar");

  await runCheck("folded bar survives a reload", async () => {
    if (!(await barState()).toggle.exists) {
      throw new Error("#bar-toggle not found (collapsible-bar feature missing)");
    }
    await cdp.reload();
    await waitReady();
    const state = await barState();
    const hidden = !groupbarVisible(state.groupbar);
    return {
      ok: state.toggle.ariaExpanded === "false" && state.stored === "folded" && hidden,
      detail: `after reload: data-bar=${JSON.stringify(state.dataBar)}, expanded=${JSON.stringify(state.toggle.ariaExpanded)}, storage=${JSON.stringify(state.stored)}, groupbar hidden=${hidden}, header=${state.headerHeight}px`,
    };
  });

  await runCheck("expanding restores the bar and stores the open state", async () => {
    const before = await barState();
    if (!before.toggle.exists) throw new Error("#bar-toggle not found (collapsible-bar feature missing)");
    if (before.toggle.ariaExpanded !== "true" || !groupbarVisible(before.groupbar)) {
      await cdp.click("#bar-toggle");
      await cdp.waitFor(
        `document.getElementById("bar-toggle")?.getAttribute("aria-expanded") === "true"`,
        { timeout: 3000, label: "group bar expanded" },
      );
      await sleep(320);
    }
    const state = await barState();
    const visible = groupbarVisible(state.groupbar);
    const grew = foldedHeaderHeight !== null && state.headerHeight !== null ? state.headerHeight > foldedHeaderHeight + 4 : true;
    return {
      ok: state.toggle.ariaExpanded === "true" && state.stored === "open" && visible && grew,
      detail: `expanded=${JSON.stringify(state.toggle.ariaExpanded)}, storage=${JSON.stringify(state.stored)}, groupbar visible=${visible}, header ${foldedHeaderHeight}px→${state.headerHeight}px`,
    };
  });

  await runCheck("collapsing under a category chip marks data-filter", async () => {
    const chip = '#group-chips .chip[data-group="grp_aaaaaaaa"]';
    try {
      await ensureBarExpanded();
      await cdp.click(chip);
      await cdp.waitFor(
        `document.querySelector(${JSON.stringify(chip)})?.getAttribute("aria-pressed") === "true"`,
        { timeout: 3000, label: "Work chip pressed" },
      );
      await cdp.waitFor(`${VISIBLE_CARDS} === 3`, {
        timeout: 3000,
        label: "Work chip filters to 3 cards",
      });
      await cdp.click("#bar-toggle");
      await cdp.waitFor(`document.querySelector("header")?.getAttribute("data-bar") === "folded"`, {
        timeout: 3000,
        label: "bar folded while filtering",
      });
      await sleep(250);
      const state = await barState();
      return {
        ok: state.toggle.dataFilter === "1",
        detail: `#bar-toggle data-filter=${JSON.stringify(state.toggle.dataFilter)} while Work chip is active`,
      };
    } finally {
      try {
        await ensureBarExpanded();
      } catch {
        /* the check already reported the missing feature */
      }
      try {
        await cdp.click('#group-chips .chip[data-group="all"]');
        await cdp.waitFor(`${VISIBLE_CARDS} === 8`, { timeout: 3000, label: "chip filter cleared" });
      } catch {
        /* page state could not be restored; the next checks report it */
      }
    }
  });

  await runCheck("page logs no console errors", async () => {
    return {
      ok: cdp.errors.length === 0,
      detail: cdp.errors.length
        ? `${cdp.errors.length} error(s): ${cdp.errors.slice(0, 3).join(" || ")}`
        : "0 console errors or uncaught exceptions",
    };
  });
}

// ---------------------------------------------------------------------------
// Teardown.
// ---------------------------------------------------------------------------

async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (KEEP) {
    console.log("\n--keep: server and Chrome left running");
    if (server) console.log(`  server  ${server.child.pid}  ${server.url ?? ""}`);
    if (chrome) console.log(`  chrome  ${chrome.child.pid}  profile ${TMP_ROOT}`);
    return;
  }
  if (cdp) cdp.close();
  if (chrome) await stopChild(chrome, 1000);
  if (server) await stopChild(server, 3000);
  if (tmpRoot) {
    try {
      await rm(tmpRoot, { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      console.warn(`cleanup: could not remove ${tmpRoot}: ${error.message}`);
    }
  }
}

process.on("exit", () => {
  if (KEEP) return;
  try {
    chrome?.child?.kill("SIGKILL");
  } catch {
    /* noop */
  }
  try {
    server?.child?.kill("SIGKILL");
  } catch {
    /* noop */
  }
});

process.on("SIGINT", () => {
  cleanup().finally(() => process.exit(130));
});

async function run() {
  let failure = null;
  try {
    await main();
  } catch (error) {
    failure = error;
    console.error(`\nSETUP FAILURE: ${error.message}`);
  }

  const passed = results.filter((result) => result.ok).length;
  const total = results.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (shots.length) {
    console.log("screenshots");
    for (const file of shots) console.log(`  ${file}`);
  }

  await cleanup();
  process.exitCode = failure || passed < total ? 1 : 0;
}

run();
