#!/usr/bin/env node
/**
 * End-to-end check for the glass UI, board rename, presence and catalog.
 *
 * Needs the app server and a headless Chrome. Usage:
 *   node scripts/e2e-ui.mjs [baseUrl]
 * default baseUrl: http://127.0.0.1:5792
 *
 * Exits non-zero on the first failing assertion group and prints every failure.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import WebSocket from "../app/node_modules/ws/index.js";

const BASE = (process.argv[2] || "http://127.0.0.1:5792").replace(/\/$/, "");
const CHROME =
  process.env.CHROME ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BOARD = "e2e-ui-probe";
const results = [];
let browser;
let cdp;
let deleteProbe = null;
let groupsToDrop = [];

function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail: String(detail || "") });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  return Boolean(ok);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.events = [];
    this.consoleErrors = [];
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
      this.events.push(message);
      if (message.method === "Runtime.exceptionThrown") {
        const details = message.params?.exceptionDetails;
        this.consoleErrors.push(details?.exception?.description || details?.text || "exception");
      }
      if (message.method === "Runtime.consoleAPICalled" && message.params?.type === "error") {
        this.consoleErrors.push(
          (message.params.args || [])
            .map((arg) => arg.value ?? arg.description ?? arg.type)
            .join(" "),
        );
      }
      if (message.method === "Log.entryAdded" && message.params?.entry?.level === "error") {
        const entry = message.params.entry;
        /* a failed subresource carries its address in entry.url; without it the
           message is just "Failed to load resource: 404" and nobody can tell
           which file went missing. */
        this.consoleErrors.push(entry.url ? `${entry.text} (${entry.url})` : entry.text);
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

  async evaluate(expression, { awaitPromise = false } = {}) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise,
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

  async waitFor(expression, { timeout = 12000, interval = 120, label = expression } = {}) {
    const deadline = Date.now() + timeout;
    let lastError = "";
    while (Date.now() < deadline) {
      try {
        // awaitPromise lets a check poll the API, not just the DOM
        if (await this.evaluate(expression, { awaitPromise: true })) return true;
      } catch (error) {
        lastError = error.message;
      }
      await sleep(interval);
    }
    throw new Error(`timeout waiting for ${label}${lastError ? ` (last: ${lastError})` : ""}`);
  }

  async click(selector) {
    const box = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    })()`);
    if (!box) throw new Error(`cannot click missing/invisible element ${selector}`);
    await sleep(80);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await this.send("Input.dispatchMouseEvent", {
        type,
        x: box.x,
        y: box.y,
        button: type === "mouseMoved" ? "none" : "left",
        buttons: type === "mousePressed" ? 1 : 0,
        clickCount: 1,
      });
    }
    return box;
  }

  async clickPoint(x, y) {
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await this.send("Input.dispatchMouseEvent", {
        type,
        x,
        y,
        button: type === "mouseMoved" ? "none" : "left",
        buttons: type === "mousePressed" ? 1 : 0,
        clickCount: 1,
      });
    }
  }

  // CDP modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8
  async clickPointWith(x, y, modifiers) {
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await this.send("Input.dispatchMouseEvent", {
        type,
        x,
        y,
        button: type === "mouseMoved" ? "none" : "left",
        buttons: type === "mousePressed" ? 1 : 0,
        clickCount: 1,
        modifiers,
      });
    }
  }

  async hold(selector, ms) {
    const box = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!box) throw new Error(`cannot hold missing/invisible element ${selector}`);
    await sleep(80);
    const base = { x: box.x, y: box.y, button: "left", clickCount: 1 };
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...base, button: "none", buttons: 0 });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base, buttons: 1 });
    await sleep(ms);
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base, buttons: 0 });
    return box;
  }

  async dragPoint(x, y, dx, dy) {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    for (let step = 1; step <= 6; step += 1) {
      await this.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: x + (dx * step) / 6,
        y: y + (dy * step) / 6,
        button: "left",
        buttons: 1,
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x + dx, y: y + dy, button: "left", buttons: 0 });
  }

  async drag(selector, dx, dy) {
    const box = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!box) throw new Error(`drag: no box for ${selector}`);
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: box.x,
      y: box.y,
      button: "none",
      buttons: 0,
    });
    await this.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: box.x,
      y: box.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    for (let step = 1; step <= 8; step += 1) {
      await this.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: box.x + (dx * step) / 8,
        y: box.y + (dy * step) / 8,
        button: "left",
        buttons: 1,
      });
      await sleep(16);
    }
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: box.x + dx,
      y: box.y + dy,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    return box;
  }

  async type(text) {
    await this.send("Input.insertText", { text });
  }

  async key(key, code, vk) {
    const base = {
      key,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
    };
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  async navigate(url) {
    await this.send("Page.navigate", { url });
    await this.waitFor("document.readyState === 'complete'", { label: `load ${url}` });
  }

  async screenshot(file) {
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    await writeFile(file, Buffer.from(data, "base64"));
  }

  async viewport(width, height, mobile = false) {
    if (width == null) {
      await this.send("Emulation.clearDeviceMetricsOverride");
      return;
    }
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile,
    });
  }
}

async function api(pathname, options) {
  const response = await fetch(`${BASE}${pathname}`, options);
  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: response.status, body };
}

async function deleteBoard(id) {
  // a board can still be holding a save when the suite ends, so one DELETE is
  // best-effort: repeat until the API reports it gone (tests leave no junk)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await api(`/api/boards/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
    const probe = await api(`/api/boards/${encodeURIComponent(id)}`).catch(() => ({ status: 404 }));
    if (probe.status === 404) return;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

function metaTitle(id) {
  return api(`/api/boards/${encodeURIComponent(id)}/meta`).then((r) => r.body?.title);
}

async function boardElementCount() {
  const response = await api(`/api/boards/${encodeURIComponent(BOARD)}`);
  return Array.isArray(response.body?.elements) ? response.body.elements.length : -1;
}

async function waitForBoardCount(min, timeout = 12000) {
  const deadline = Date.now() + timeout;
  let count = -1;
  while (Date.now() < deadline) {
    count = await boardElementCount();
    if (count >= min) return count;
    await sleep(200);
  }
  return count;
}

/* The extra tools (table, ER class, minimap, lasso) live behind one overflow button in
   the drawing-tools row, so every test that used to click their own buttons
   opens the menu and picks the row by its Thai label. */
async function openToolsMenu() {
  await cdp.click(".tools-more");
  await cdp.waitFor(`!!document.querySelector(".tools-more-menu")`, { label: "tools menu open" });
}

async function closeToolsMenu() {
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 53,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 53,
  });
  await cdp.waitFor(`!document.querySelector(".tools-more-menu")`, { label: "tools menu closed" });
}

async function pickTool(label) {
  await openToolsMenu();
  const picked = await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll(".tools-more-row")]
      .find((b) => b.querySelector(".tools-more-label")?.textContent === ${JSON.stringify(label)});
    if (!row) return false;
    row.click();
    return true;
  })()`);
  if (!picked) throw new Error(`tools menu has no row labelled ${label}`);
  await cdp.waitFor(`!document.querySelector(".tools-more-menu")`, { label: `tools menu closed after ${label}` });
}

async function toolRowState(label) {
  await openToolsMenu();
  const state = await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll(".tools-more-row")]
      .find((b) => b.querySelector(".tools-more-label")?.textContent === ${JSON.stringify(label)});
    return row ? { checked: row.getAttribute("aria-checked"), hint: row.querySelector(".tools-more-hint")?.textContent } : null;
  })()`);
  await closeToolsMenu();
  return state;
}

async function openEditor(boardId = BOARD) {
  await cdp.navigate(`${BASE}/b/${boardId}`);
  await cdp.waitFor(
    `!!window.__boardsApi && !!document.querySelector(".presence") && !!document.querySelector(".tools-more") && !document.querySelector(".bar") && !document.body.textContent.includes("กำลังโหลดกระดาน")`,
    { label: "editor ready" },
  );
}

(async () => {
  const port = await freePort();
  const profile = await mkdtemp(path.join(os.tmpdir(), "dsh-e2e-chrome-"));
  browser = spawn(
    CHROME,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--window-size=1440,900",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  try {
    let targets;
    for (let i = 0; i < 100; i += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`);
        targets = await response.json();
        if (targets.length) break;
      } catch {
        /* chrome still starting */
      }
      await sleep(100);
    }
    const page = targets?.find((target) => target.type === "page");
    if (!page) throw new Error("headless Chrome did not expose a page target");

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    cdp = new CDP(ws);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Network.enable");

    await deleteBoard(BOARD);
    const created = await api("/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: BOARD }),
    });
    if (created.status !== 200 && created.status !== 201) {
      throw new Error(`cannot create test board: ${created.status} ${JSON.stringify(created.body)}`);
    }

    /* ------------------------------------------------------------ editor */
    await openEditor();
    const editorMesh = await cdp.evaluate(`getComputedStyle(document.body).backgroundImage.includes("radial-gradient")`);
    check("editor body has glass mesh", editorMesh, String(editorMesh));
    const toolbars = await cdp.evaluate(`(() => ({
      appBar: !!document.querySelector(".bar"),
      tools: !!document.querySelector(".App-toolbar"),
      rows: document.querySelectorAll(".bar, .App-toolbar").length,
    }))()`);
    check("editor has no separate app bar", toolbars.appBar === false && toolbars.tools === true && toolbars.rows === 1, JSON.stringify(toolbars));

    const canvasRect = await cdp.evaluate(`(() => {
      const r = document.querySelector(".canvas").getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height, vw: innerWidth, vh: innerHeight };
    })()`);
    check(
      "canvas fills the page",
      canvasRect.left === 0 &&
        canvasRect.top === 0 &&
        Math.abs(canvasRect.width - canvasRect.vw) <= 1 &&
        Math.abs(canvasRect.height - canvasRect.vh) <= 1,
      JSON.stringify(canvasRect),
    );

    const backChrome = await cdp.evaluate(`(() => {
      const mid = (el) => { const r = el.getBoundingClientRect(); return Math.round(r.top + r.height / 2); };
      const back = document.querySelector(".back-fab");
      const menu = document.querySelector(".dropdown-menu-button");
      const presence = document.querySelector(".presence");
      const backRect = back.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      return {
        back: [backRect.left, backRect.top, backRect.right, backRect.bottom].map(Math.round),
        backMid: mid(back), menuMid: mid(menu), presenceMid: mid(presence),
        menuLeft: Math.round(menuRect.left), backRight: Math.round(backRect.right),
        vw: innerWidth,
      };
    })()`);
    check(
      "back button, menu and avatars share one top band",
      backChrome.back[0] <= 16 && backChrome.back[1] <= 16 &&
        Math.abs(backChrome.menuMid - backChrome.backMid) <= 2 &&
        Math.abs(backChrome.presenceMid - backChrome.backMid) <= 2 &&
        backChrome.menuLeft >= backChrome.backRight + 2,
      JSON.stringify(backChrome),
    );

    const backButton = await cdp.evaluate(`(() => {
      const back = document.querySelector(".back-fab");
      const r = back?.getBoundingClientRect();
      return {
        exists: !!back,
        href: back?.getAttribute("href") || null,
        left: r?.left ?? null,
        top: r?.top ?? null,
        appBar: !!document.querySelector(".bar"),
      };
    })()`);
    check(
      "back button links to the catalogue",
      backButton.exists && backButton.href === "/" && !backButton.appBar &&
        backButton.left <= 16 && backButton.top <= 16,
      JSON.stringify(backButton),
    );

    const toolsBefore = await cdp.evaluate(`(() => {
      const tools = document.querySelector(".App-toolbar");
      const r = tools?.getBoundingClientRect();
      return {
        exists: !!tools,
        floating: tools?.classList.contains("tools-floating") || false,
        position: tools ? getComputedStyle(tools).position : null,
        grip: !!tools?.querySelector(".tools-grip"),
        fold: !!tools?.querySelector(".tools-fold"),
        launcher: !!document.querySelector(".tools-launcher"),
        left: r?.left ?? null,
        top: r?.top ?? null,
        width: r?.width ?? 0,
        mid: r ? Math.round(r.top + r.height / 2) : null,
        backMid: (() => { const b = document.querySelector(".back-fab").getBoundingClientRect(); return Math.round(b.top + b.height / 2); })(),
        presenceLeft: Math.round(document.querySelector(".presence").getBoundingClientRect().left),
        centred: r ? Math.round((r.left + r.width / 2) * 2) / 2 - innerWidth / 2 : null,
      };
    })()`);
    check(
      "drawing tools are a separate floating island on the same line",
      toolsBefore.exists && toolsBefore.floating && toolsBefore.position === "fixed" &&
        Math.abs(toolsBefore.mid - toolsBefore.backMid) <= 2 &&
        toolsBefore.left + toolsBefore.width <= toolsBefore.presenceLeft,
      JSON.stringify(toolsBefore),
    );
    check(
      "the tool row has no move grip, no fold button and no folded pill",
      !toolsBefore.grip && !toolsBefore.fold && !toolsBefore.launcher,
      JSON.stringify({ grip: toolsBefore.grip, fold: toolsBefore.fold, launcher: toolsBefore.launcher }),
    );
    check(
      "the tool row sits centred above the canvas",
      toolsBefore.centred !== null && Math.abs(toolsBefore.centred) <= 2,
      JSON.stringify({ left: toolsBefore.left, width: toolsBefore.width, centred: toolsBefore.centred }),
    );

    // The row used to follow the pointer from its grip or any blank part of the
    // island. Neither exists now: a drag on the row itself must leave it alone
    // and must not write a remembered spot.
    const dragProof = await cdp.evaluate(`(async () => {
      const tools = document.querySelector(".App-toolbar");
      const r = tools.getBoundingClientRect();
      const before = { left: Math.round(r.left), top: Math.round(r.top) };
      localStorage.removeItem("boards-tools");
      const start = { clientX: r.left + 6, clientY: r.top + r.height / 2, pointerId: 1, button: 0, bubbles: true, cancelable: true };
      tools.dispatchEvent(new PointerEvent("pointerdown", { ...start, buttons: 1 }));
      window.dispatchEvent(new PointerEvent("pointermove", { ...start, buttons: 1, clientX: start.clientX + 90, clientY: start.clientY + 60 }));
      window.dispatchEvent(new PointerEvent("pointerup", { ...start, buttons: 0, clientX: start.clientX + 90, clientY: start.clientY + 60 }));
      await new Promise((resolve) => setTimeout(resolve, 250));
      const after = tools.getBoundingClientRect();
      return { before, after: { left: Math.round(after.left), top: Math.round(after.top) }, stored: localStorage.getItem("boards-tools"), cursor: getComputedStyle(tools).cursor };
    })()`, { awaitPromise: true });
    check(
      "the tool row cannot be dragged and remembers no spot",
      dragProof.before.left === dragProof.after.left && dragProof.before.top === dragProof.after.top &&
        dragProof.stored === null && dragProof.cursor !== "grab",
      JSON.stringify(dragProof),
    );

    const rowStays = await cdp.evaluate(`(() => ({
      collapsedClass: document.querySelector(".shell").classList.contains("tools-collapsed"),
      display: getComputedStyle(document.querySelector(".App-toolbar")).display,
      foldedButton: !!document.querySelector(".tools-fold, .tools-launcher"),
    }))()`);
    check(
      "the drawing tools cannot be folded away",
      !rowStays.collapsedClass && rowStays.display !== "none" && !rowStays.foldedButton,
      JSON.stringify(rowStays),
    );

    const tablePlacement = await cdp.evaluate(`(() => {
      const table = document.querySelector(".tools-more");
      const stack = document.querySelector(".App-toolbar .Stack_horizontal");
      const tools = document.querySelector(".App-toolbar").getBoundingClientRect();
      const native = document.querySelector(".App-toolbar .ToolIcon__icon")?.getBoundingClientRect();
      const r = table ? table.getBoundingClientRect() : null;
      return {
        inStack: Boolean(stack && table && stack.contains(table)),
        insideTools: Boolean(r && r.left >= tools.left - 1 && r.right <= tools.right + 1),
        w: r ? r.width : null, h: r ? r.height : null,
        nativeW: native ? native.width : null, nativeH: native ? native.height : null,
        label: table ? table.getAttribute("aria-label") : null,
      };
    })()`);
    check("the extra tools button moved into the drawing tools row", tablePlacement.inStack && tablePlacement.insideTools, JSON.stringify(tablePlacement));
    const boardButtons = await cdp.evaluate(`(() => {
      const slot = document.querySelector(".tools-table-slot");
      const row = document.querySelector(".App-toolbar").getBoundingClientRect();
      const all = [...(slot ? slot.querySelectorAll("button") : [])].map((b) => {
        const r = b.getBoundingClientRect();
        return { cls: b.className.toString(), inside: r.left >= row.left - 1 && r.right <= row.right + 1, w: Math.round(r.width) };
      });
      return { count: all.length, all, vw: innerWidth };
    })()`);
    check(
      "one overflow button replaces the extra tools in the row",
      boardButtons.count === 1 && boardButtons.all[0].cls.includes("tools-more") && boardButtons.all.every((b) => b.inside && b.w > 20),      JSON.stringify(boardButtons),
    );
    check(
      "the overflow button matches the native tool size",
      Math.abs((tablePlacement.w ?? 0) - (tablePlacement.nativeW ?? 29)) < 1.5 &&
        Math.abs((tablePlacement.h ?? 0) - (tablePlacement.nativeH ?? 29)) < 1.5,
      JSON.stringify(tablePlacement),
    );

    await openToolsMenu();
    const menuBox = await cdp.evaluate(`(() => {
      const menu = document.querySelector(".tools-more-menu");
      const trigger = document.querySelector(".tools-more");
      const r = menu.getBoundingClientRect();
      const t = trigger.getBoundingClientRect();
      return {
        rows: [...menu.querySelectorAll(".tools-more-row")].map((b) => b.querySelector(".tools-more-label").textContent),
        role: menu.getAttribute("role"),
        expanded: trigger.getAttribute("aria-expanded"),
        inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
        under: r.top >= t.bottom - 1,
      };
    })()`);
    check(
      "the overflow menu lists the extra tools under its button",
      menuBox.rows.join("|") === "เลเซอร์พอยต์|สร้างตาราง|ER diagram|แผนที่ย่อ|เลือกแบบบ่วง" &&
        menuBox.role === "menu" && menuBox.expanded === "true" && menuBox.inside && menuBox.under,
      JSON.stringify(menuBox),
    );
    await closeToolsMenu();
    check(
      "Escape closes the overflow menu without touching the board",
      (await cdp.evaluate(`!document.querySelector(".tools-more-menu") && document.querySelector(".tools-more").getAttribute("aria-expanded") === "false"`)) === true,
    );

    await pickTool("เลเซอร์พอยต์");
    await cdp.waitFor(`window.__boardsApi.getAppState().activeTool.type === "laser"`, {
      label: "the laser tool",
      timeout: 4000,
    }).catch(() => null);
    const laserState = await toolRowState("เลเซอร์พอยต์");
    const laserTool = await cdp.evaluate(`window.__boardsApi.getAppState().activeTool.type`);
    check(
      "the menu arms the laser and marks the row while it is on",
      laserTool === "laser" && laserState.checked === "true" && laserState.hint === "กดค้างแล้วลาก",
      JSON.stringify({ laserTool, ...laserState }),
    );
    await cdp.evaluate(`window.__boardsApi.setActiveTool({ type: "selection" })`);
    await cdp.waitFor(`window.__boardsApi.getAppState().activeTool.type === "selection"`, {
      label: "back to the selection tool",
      timeout: 4000,
    }).catch(() => null);
    const laserOff = await toolRowState("เลเซอร์พอยต์");
    check(
      "picking another tool clears the laser row by itself",
      laserOff.checked === "false" && (await cdp.evaluate(`window.__boardsApi.getAppState().activeTool.type`)) === "selection",
      JSON.stringify(laserOff),
    );

    const presenceBox = await cdp.evaluate(`(() => {
      const p = document.querySelector(".presence");
      const r = p.getBoundingClientRect();
      const row = p.closest(".layer-ui__wrapper__top-right");
      const lib = document.querySelector(".layer-ui__wrapper__top-right .sidebar-trigger");
      const libRect = lib ? lib.getBoundingClientRect() : null;
      return {
        cls: p.className,
        docked: Boolean(row),
        parent: p.parentElement.className,
        inSlot: Boolean(p.closest(".presence-slot")),
        rect: [r.left, r.top, r.right, r.bottom].map((n) => Math.round(n)),
        top: Math.round(r.top), height: Math.round(r.height), left: Math.round(r.left),
        libTop: libRect ? Math.round(libRect.top) : null,
        libLeft: libRect ? Math.round(libRect.left) : null,
        avatars: p.querySelectorAll(".presence-avatar").length,
        avatarInk: p.querySelector(".presence-avatar") ? getComputedStyle(p.querySelector(".presence-avatar")).color : null,
        count: p.querySelector(".presence-count")?.textContent ?? null,
        title: p.getAttribute("title"),
      };
    })()`);
    check(
      "presence rides in Excalidraw's top-right menu row",
      presenceBox.docked === true &&
        presenceBox.parent === "top-actions docked" &&
        presenceBox.inSlot === true,
      JSON.stringify(presenceBox),
    );
    check(
      "presence lines up with the library button",
      presenceBox.libTop !== null &&
        Math.abs(presenceBox.top - presenceBox.libTop) <= 2 &&
        presenceBox.left <= presenceBox.libLeft - 8,
      JSON.stringify(presenceBox),
    );
    check(
      "presence shows an avatar stack with a peer count",
      presenceBox.avatars >= 1 && /\u0e04\u0e19/.test(presenceBox.count || ""),
      JSON.stringify(presenceBox),
    );

    const inertClosed = await cdp.evaluate(`document.querySelector(".panel").hasAttribute("inert")`);
    check("closed table panel is inert", inertClosed === true, inertClosed);
    const beforeTable = await boardElementCount();
    await pickTool("สร้างตาราง");
    await cdp.waitFor(`document.querySelector(".panel")?.classList.contains("open")`, {
      label: "table panel open",
    });
    await cdp.waitFor(`(() => {
      const p = document.querySelector(".panel");
      const r = p.getBoundingClientRect();
      return r.right <= innerWidth + 1 && r.left >= 0;
    })()`, { label: "table panel slides in" });
    const tableRow = await toolRowState("สร้างตาราง");
    check(
      "the menu row shows the table panel is open",
      tableRow?.checked === "true",
      JSON.stringify(tableRow),
    );
    const panelGlass = await cdp.evaluate(`(() => {
      const panel = document.querySelector(".panel");
      const style = getComputedStyle(panel);
      return {
        blur: style.backdropFilter || style.webkitBackdropFilter,
        bg: style.backgroundImage,
        width: style.width,
        hidden: panel.getAttribute("aria-hidden"),
      };
    })()`);
    check("table panel is a glass drawer", /blur/.test(panelGlass.blur || "") && /rgba\(255, 255, 255/.test(panelGlass.bg), `${panelGlass.blur} / ${panelGlass.bg}`);
    check("table panel is open for interaction", panelGlass.hidden === "false", panelGlass.hidden);
    check("open table panel is not inert", (await cdp.evaluate(`document.querySelector(".panel").hasAttribute("inert")`)) === false);
    await cdp.click(".panel.open .panel-body > button.btn.wide");
    await cdp.waitFor(`/แทรกตารางแล้ว/.test(document.querySelector(".panel .note")?.textContent || "")`, {
      label: "table inserted",
    });
    const afterTable = await waitForBoardCount(beforeTable + 5);
    check("table insertion saves elements", afterTable >= beforeTable + 5, `${beforeTable} -> ${afterTable}`);
    await cdp.click(".panel-head .icon-btn");
    await cdp.waitFor(`!document.querySelector(".panel")?.classList.contains("open")`, {
      label: "table panel close",
    });
    check(
      "the menu row clears when the panel closes",
      (await toolRowState("สร้างตาราง"))?.checked === "false",
    );

    /* the `+` handle on a table grows it in place; it never clones it */
    const gridShape = (gridId) =>
      cdp.evaluate(`(() => {
        const api = window.__boardsApi;
        const els = api.getSceneElements().filter((el) => !el.isDeleted);
        const cells = els.filter((el) => el.customData?.grid === ${JSON.stringify(gridId)} && el.customData?.r != null);
        return {
          rows: new Set(cells.map((el) => el.customData.r)).size,
          cols: new Set(cells.map((el) => el.customData.c)).size,
          frames: new Set(els.filter((el) => el.customData?.frame).map((el) => el.customData.grid)).size,
          arrows: els.filter((el) => el.type === "arrow").length,
        };
      })()`);
    // hover the top edge of a grid: bounds come from its cells, because a plain
    // table only gets a frame element once a relation needs one. The edge is a
    // line, so a pill shows up there (the middle of a table is a bare cell).
    const hoverFrame = async (gridId) => {
      const centre = () =>
        cdp.evaluate(`(() => {
          const api = window.__boardsApi;
          const els = api.getSceneElements().filter((el) => el.customData?.grid === ${JSON.stringify(gridId)} && !el.isDeleted);
          if (!els.length) return null;
          const s = api.getAppState();
          const zoom = s.zoom?.value || 1;
          const host = document.querySelector(".canvas").getBoundingClientRect();
          const left = Math.min(...els.map((el) => el.x));
          const top = Math.min(...els.map((el) => el.y));
          const right = Math.max(...els.map((el) => el.x + el.width));
          return {
            x: host.left + ((left + right) / 2 + (s.scrollX || 0)) * zoom,
            y: host.top + (top + (s.scrollY || 0)) * zoom,
          };
        })()`);
      await cdp.evaluate(`(() => {
        const api = window.__boardsApi;
        const els = api.getSceneElements().filter((el) => el.customData?.grid === ${JSON.stringify(gridId)} && !el.isDeleted);
        api.scrollToContent(els, { fitToContent: true, animate: false });
      })()`);
      await sleep(200);
      const point = await centre();
      if (!point) throw new Error(`grid ${gridId} has no elements to hover`);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none", buttons: 0 });
      await cdp.waitFor(
        `[...document.querySelectorAll(".grid-add-btn")].some((el) => Number(getComputedStyle(el).opacity) > 0.5)`,
        { label: "grid pill" },
      );
    };

    const tableGrid = await cdp.evaluate(`(() => {
      const cell = window.__boardsApi.getSceneElements()
        .find((el) => el.customData?.grid && el.customData?.class !== true && !el.isDeleted);
      return cell?.customData?.grid || null;
    })()`);
    check("the inserted table has a grid handle target", Boolean(tableGrid), String(tableGrid));
    const tableBefore = await gridShape(tableGrid);
    /* One pill per surface: a grid line offers an insert at that boundary, a
       cell offers dropping the row and the column it belongs to. */
    const gridGeom = () =>
      cdp.evaluate(`(() => {
        const api = window.__boardsApi;
        const cells = api.getSceneElements().filter((el) => el.customData?.grid === ${JSON.stringify(tableGrid)} && el.customData?.r != null && el.customData?.c != null && !el.isDeleted);
        if (!cells.length) return null;
        const s = api.getAppState();
        const zoom = s.zoom?.value || 1;
        const host = document.querySelector(".canvas").getBoundingClientRect();
        const sx = (x) => host.left + (x + (s.scrollX || 0)) * zoom;
        const sy = (y) => host.top + (y + (s.scrollY || 0)) * zoom;
        const rowTop = new Map();
        const rowBottom = new Map();
        const colLeft = new Map();
        const colRight = new Map();
        for (const el of cells) {
          const r = el.customData.r;
          const c = el.customData.c;
          rowTop.set(r, Math.min(rowTop.get(r) ?? Infinity, el.y));
          rowBottom.set(r, Math.max(rowBottom.get(r) ?? -Infinity, el.y + el.height));
          colLeft.set(c, Math.min(colLeft.get(c) ?? Infinity, el.x));
          colRight.set(c, Math.max(colRight.get(c) ?? -Infinity, el.x + el.width));
        }
        return {
          table: {
            left: sx(Math.min(...cells.map((el) => el.x))),
            top: sy(Math.min(...cells.map((el) => el.y))),
            right: sx(Math.max(...cells.map((el) => el.x + el.width))),
            bottom: sy(Math.max(...cells.map((el) => el.y + el.height))),
          },
          rows: [...rowTop.keys()].sort((a, b) => a - b).map((r) => ({ r, top: sy(rowTop.get(r)), bottom: sy(rowBottom.get(r)) })),
          cols: [...colLeft.keys()].sort((a, b) => a - b).map((c) => ({ c, left: sx(colLeft.get(c)), right: sx(colRight.get(c)) })),
        };
      })()`);

    const pills = () =>
      cdp.evaluate(`(() => {
        const read = (selector) => {
          const el = document.querySelector(selector);
          if (!el) return null;
          const style = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return {
            axis: el.dataset.axis,
            at: Number(el.dataset.at),
            label: el.getAttribute("aria-label"),
            text: (el.textContent || "").trim(),
            visible: Number(style.opacity) > 0.5 && r.width > 0,
            left: r.left, top: r.top, right: r.right, bottom: r.bottom,
            cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2,
            disabled: el.disabled,
          };
        };
        return { insert: read(".grid-add-insert"), row: read(".grid-add-row-del"), col: read(".grid-add-col-del") };
      })()`);

    const moveTo = async (x, y) => {
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
      await sleep(90);
    };
    // a grid rebuild scrolls the rebuilt table into view with an animation, so a
    // point measured before it finishes points at the wrong cell by click time
    const camSettled = async () => {
      let prev = null;
      for (let i = 0; i < 24; i += 1) {
        const now = await cdp.evaluate(
          `(() => { const s = window.__boardsApi.getAppState(); return [Math.round(s.scrollX || 0), Math.round(s.scrollY || 0)]; })()`,
        );
        if (prev && prev[0] === now[0] && prev[1] === now[1]) return now;
        prev = now;
        await sleep(110);
      }
      return prev;
    };
    const waitPill = (selector, at) =>
      cdp.waitFor(
        `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return false;
          return Number(getComputedStyle(el).opacity) > 0.5 && Number(el.dataset.at) === ${at};
        })()`,
        { label: `pill ${selector} at ${at}` },
      );
    const clickPill = async (selector) => {
      const point = await cdp.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
      })()`);
      if (!point) throw new Error(`missing pill ${selector}`);
      await cdp.clickPoint(point.x, point.y);
      await sleep(420); // the rebuilt grid animates back into view
    };
    const waitRows = (n) =>
      cdp.waitFor(
        `(() => {
          const cells = window.__boardsApi.getSceneElements().filter((el) => el.customData?.grid === ${JSON.stringify(tableGrid)} && el.customData?.r != null && !el.isDeleted);
          return new Set(cells.map((el) => el.customData.r)).size === ${n};
        })()`,
        { label: `table with ${n} rows` },
      );
    const waitCols = (n) =>
      cdp.waitFor(
        `(() => {
          const cells = window.__boardsApi.getSceneElements().filter((el) => el.customData?.grid === ${JSON.stringify(tableGrid)} && el.customData?.c != null && !el.isDeleted);
          return new Set(cells.map((el) => el.customData.c)).size === ${n};
        })()`,
        { label: `table with ${n} columns` },
      );
    const cellPoint = (r, c) =>
      cdp.evaluate(`(() => {
        const api = window.__boardsApi;
        const cell = api.getSceneElements().find((el) => el.customData?.grid === ${JSON.stringify(tableGrid)} && el.customData?.r === ${r} && el.customData?.c === ${c} && !el.isDeleted);
        if (!cell) return null;
        const s = api.getAppState();
        const zoom = s.zoom?.value || 1;
        const host = document.querySelector(".canvas").getBoundingClientRect();
        return {
          x: host.left + (cell.x + cell.width / 2 + (s.scrollX || 0)) * zoom,
          y: host.top + (cell.y + cell.height / 2 + (s.scrollY || 0)) * zoom,
        };
      })()`);
    const doubleClick = async (x, y) => {
      for (const count of [1, 2]) {
        await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: count });
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: count });
        await sleep(30);
      }
    };
    const textCell = () =>
      cdp.evaluate(`(() => {
        const els = window.__boardsApi.getSceneElements();
        const t = els.find((el) => el.type === "text" && el.text === "alpha" && el.containerId && !el.isDeleted);
        if (!t) return null;
        const cell = els.find((el) => el.id === t.containerId);
        return cell ? { r: cell.customData?.r, c: cell.customData?.c } : null;
      })()`);
    const hoverLine = async (axis, at) => {
      const g = await gridGeom();
      if (axis === "row") {
        const y = at < g.rows.length ? g.rows[at].top : g.table.bottom;
        await moveTo(g.table.left + 30, y);
        return g;
      }
      const x = at < g.cols.length ? g.cols[at].left : g.table.right;
      const row = g.rows[1] ?? g.rows[0];
      await moveTo(x, (row.top + row.bottom) / 2);
      return g;
    };
    const hoverCell = async (r, c) => {
      const p = await cellPoint(r, c);
      if (!p) throw new Error(`no cell ${r}:${c} to hover`);
      await moveTo(p.x, p.y);
      return gridGeom();
    };
    /* the top border, lined up with one column: the removals live on the border */
    const hoverTopBorder = async (c) => {
      const g = await gridGeom();
      const col = g.cols[c] ?? g.cols[g.cols.length - 1];
      await moveTo((col.left + col.right) / 2, g.table.top);
      return g;
    };
    /* the left border, lined up with one row */
    const hoverLeftBorder = async (r) => {
      const g = await gridGeom();
      const row = g.rows[r] ?? g.rows[g.rows.length - 1];
      await moveTo(g.table.left, (row.top + row.bottom) / 2);
      return g;
    };

    /* nothing rides a cell: both removals used to sit over the cells around it
       and swallowed the clicks aimed at them */
    await hoverFrame(tableGrid);
    await hoverCell(1, 1);
    const cellView = await pills();
    check(
      "hovering a cell offers no pill at all",
      Boolean(cellView.insert && cellView.row && cellView.col) &&
        !cellView.insert.visible &&
        !cellView.row.visible &&
        !cellView.col.visible,
      JSON.stringify({ insert: cellView.insert?.visible, row: cellView.row?.visible, col: cellView.col?.visible }),
    );

    /* a line offers one insert, at that exact boundary */
    const rowLineGeom = await hoverLine("row", 1);
    await waitPill(".grid-add-insert", 1);
    const rowLineView = await pills();
    check(
      "hovering a row line offers an insert at that boundary",
      Boolean(rowLineView.insert?.visible) &&
        rowLineView.insert.axis === "row" &&
        rowLineView.insert.text === "แถว" &&
        !rowLineView.row?.visible &&
        !rowLineView.col?.visible,
      JSON.stringify(rowLineView),
    );
    check(
      "the row insert sits outside the left edge, level with the line",
      Boolean(rowLineView.insert) &&
        rowLineView.insert.right <= rowLineGeom.table.left - 8 &&
        Math.abs(rowLineView.insert.cy - rowLineGeom.rows[1].top) <= 2,
      `insert ${JSON.stringify(rowLineView.insert)} line y ${rowLineGeom.rows[1].top} table ${JSON.stringify(rowLineGeom.table)}`,
    );

    const colLineGeom = await hoverLine("col", 1);
    await waitPill(".grid-add-insert", 1);
    const colLineView = await pills();
    check(
      "hovering a column line offers an insert, level with that line",
      Boolean(colLineView.insert?.visible) &&
        colLineView.insert.axis === "col" &&
        colLineView.insert.text === "คอลัมน์" &&
        Math.abs(colLineView.insert.cx - colLineGeom.cols[1].left) <= 2 &&
        colLineView.insert.bottom <= colLineGeom.table.top - 8,
      `insert ${JSON.stringify(colLineView.insert)} line x ${colLineGeom.cols[1].left} table ${JSON.stringify(colLineGeom.table)}`,
    );

    /* an outer side border drops the row it is level with, and still carries the
       insert of the line it happens to be */
    const sideGeom = await hoverLeftBorder(1);
    await waitPill(".grid-add-row-del", 1);
    const sideView = await pills();
    check(
      "the left border offers dropping the row beside it",
      Boolean(sideView.row?.visible) &&
        sideView.row.at === 1 &&
        sideView.row.text === "แถว" &&
        !sideView.col?.visible &&
        sideView.row.right <= sideGeom.table.left - 4 &&
        Math.abs(sideView.row.cy - (sideGeom.rows[1].top + sideGeom.rows[1].bottom) / 2) <= 2,
      `row ${JSON.stringify(sideView.row)} table ${JSON.stringify(sideGeom.table)}`,
    );
    check(
      "that border still offers the insert on the line it carries",
      Boolean(sideView.insert?.visible) && sideView.insert.axis === "col" && sideView.insert.at === 0,
      JSON.stringify(sideView.insert),
    );

    /* the top border drops the column it is level with */
    const topGeom = await hoverTopBorder(1);
    await waitPill(".grid-add-col-del", 1);
    const topView = await pills();
    check(
      "the top border offers dropping the column beside it",
      Boolean(topView.col?.visible) &&
        topView.col.at === 1 &&
        topView.col.text === "คอลัมน์" &&
        !topView.row?.visible &&
        topView.col.bottom <= topGeom.table.top - 4 &&
        Math.abs(topView.col.cx - (topGeom.cols[1].left + topGeom.cols[1].right) / 2) <= 2,
      `col ${JSON.stringify(topView.col)} table ${JSON.stringify(topGeom.table)}`,
    );

    /* the first cell gets a word, so an insert above or before it has to carry
       the word to the next r/c instead of leaving it on the wrong cell */
    await cdp.evaluate(`(() => { try { window.__boardsApi.setActiveTool({ type: "selection" }); } catch { /* older api */ } })()`);
    const firstCell = await cellPoint(0, 0);
    await doubleClick(firstCell.x, firstCell.y);
    await cdp.waitFor(`Boolean(document.activeElement && document.activeElement.tagName === "TEXTAREA")`, { label: "cell text editor" });
    await cdp.type("alpha");
    await cdp.key("Escape", "Escape", 27);
    await cdp.waitFor(`(() => {
      const els = window.__boardsApi.getSceneElements();
      return els.some((el) => el.type === "text" && el.text === "alpha" && el.containerId && !el.isDeleted);
    })()`, { label: "cell text committed" });
    const typed = await textCell();
    check("the first cell keeps the typed word", typed?.r === 0 && typed?.c === 0, JSON.stringify(typed));

    /* a single click on a cell must not paint the old row/column band or badge */
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: firstCell.x, y: firstCell.y, button: "none", buttons: 0 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: firstCell.x, y: firstCell.y, button: "left", buttons: 1, clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: firstCell.x, y: firstCell.y, button: "left", buttons: 0, clickCount: 1 });
    await sleep(300);
    const painted = await cdp.evaluate(`(() => ({
      overlay: Boolean(document.querySelector(".grid-overlay")),
      badge: [...document.querySelectorAll("div")].some((el) => /^แถว \\d+ · คอลัมน์ \\d+$/.test((el.textContent || "").trim())),
    }))()`);
    check("clicking a cell paints no row/column highlight", painted && painted.overlay === false && painted.badge === false, JSON.stringify(painted));

    const shape0 = await gridShape(tableGrid);
    const rows0 = shape0.rows;
    const cols0 = shape0.cols;

    /* insert a row between row 0 and row 1: the word must not move */
    await hoverLine("row", 1);
    await waitPill(".grid-add-insert", 1);
    await clickPill(".grid-add-insert");
    await waitRows(rows0 + 1);
    const midGrown = await gridShape(tableGrid);
    const afterMid = await textCell();
    check(
      "+ on a line between rows 0 and 1 inserts there and leaves the word above",
      midGrown.rows === rows0 + 1 && midGrown.cols === cols0 && afterMid?.r === 0 && afterMid?.c === 0,
      `${JSON.stringify(shape0)} -> ${JSON.stringify(midGrown)} text ${JSON.stringify(afterMid)}`,
    );

    /* drop that same row by pointing at its side border */
    await hoverLeftBorder(1);
    await waitPill(".grid-add-row-del", 1);
    const dropView = await pills();
    check(
      "the side border names the row under the pointer",
      dropView.row.at === 1 && !dropView.col?.visible,
      JSON.stringify({ row: dropView.row?.at, col: dropView.col?.visible }),
    );
    await clickPill(".grid-add-row-del");
    await waitRows(rows0);
    const afterDrop = await textCell();
    check(
      "- on the side border drops exactly that row and keeps the word",
      (await gridShape(tableGrid)).rows === rows0 && afterDrop?.r === 0 && afterDrop?.c === 0,
      JSON.stringify(afterDrop),
    );

    /* insert above the first row: the word slides down one */
    await hoverLine("row", 0);
    await waitPill(".grid-add-insert", 0);
    await clickPill(".grid-add-insert");
    await waitRows(rows0 + 1);
    const afterTop = await textCell();
    check(
      "+ on the top edge inserts above the word and pushes it down",
      (await gridShape(tableGrid)).rows === rows0 + 1 && afterTop?.r === 1 && afterTop?.c === 0,
      JSON.stringify(afterTop),
    );

    /* and drop that empty first row from its side border */
    await hoverLeftBorder(0);
    await waitPill(".grid-add-row-del", 0);
    await clickPill(".grid-add-row-del");
    await waitRows(rows0);
    const afterFrontDrop = await textCell();
    check(
      "- on the first row's border drops it and pulls the word back up",
      (await gridShape(tableGrid)).rows === rows0 && afterFrontDrop?.r === 0 && afterFrontDrop?.c === 0,
      JSON.stringify(afterFrontDrop),
    );

    /* same for columns: insert before the word, then drop the empty column */
    await hoverLine("col", 0);
    await waitPill(".grid-add-insert", 0);
    await clickPill(".grid-add-insert");
    await waitCols(cols0 + 1);
    const afterLeftAdd = await textCell();
    check(
      "+ on the left edge inserts before the word and pushes it right",
      (await gridShape(tableGrid)).cols === cols0 + 1 && afterLeftAdd?.r === 0 && afterLeftAdd?.c === 1,
      JSON.stringify(afterLeftAdd),
    );
    await hoverTopBorder(0);
    await waitPill(".grid-add-col-del", 0);
    await clickPill(".grid-add-col-del");
    await waitCols(cols0);
    const afterLeftDrop = await textCell();
    check(
      "- on the first column's border drops it and pulls the word back",
      (await gridShape(tableGrid)).cols === cols0 && afterLeftDrop?.r === 0 && afterLeftDrop?.c === 0,
      JSON.stringify(afterLeftDrop),
    );

    /* a column inserted in the middle keeps the word where it was */
    await hoverLine("col", 2);
    await waitPill(".grid-add-insert", 2);
    await clickPill(".grid-add-insert");
    await waitCols(cols0 + 1);
    const afterMidCol = await textCell();
    check(
      "+ between columns 1 and 2 inserts there and leaves the word alone",
      (await gridShape(tableGrid)).cols === cols0 + 1 && afterMidCol?.r === 0 && afterMidCol?.c === 0,
      JSON.stringify(afterMidCol),
    );
    await hoverTopBorder(2); // the column inserted at boundary 2 now sits there
    await waitPill(".grid-add-col-del", 2);
    await clickPill(".grid-add-col-del");
    await waitCols(cols0);
    const backToStart = await gridShape(tableGrid);
    check(
      "- on the inserted column's border returns the table to its first shape",
      backToStart.rows === rows0 && backToStart.cols === cols0 && backToStart.frames === shape0.frames,
      `${JSON.stringify(shape0)} -> ${JSON.stringify(backToStart)}`,
    );

    /* --------------------- the pills follow the pointer, they do not stick */
    await hoverLeftBorder(1);
    await waitPill(".grid-add-row-del", 1);
    await moveTo(60, 320); // empty canvas, well clear of the table
    await sleep(240);
    const away = await pills();
    check(
      "the border pills leave when the pointer does",
      !away.insert?.visible && !away.row?.visible && !away.col?.visible,
      JSON.stringify({ insert: away.insert?.visible, row: away.row?.visible, col: away.col?.visible }),
    );


    /* ----------------------------- a click picks one cell, not the table */
    const selection = () =>
      cdp.evaluate(`(() => {
        const api = window.__boardsApi;
        const state = api.getAppState();
        const ids = Object.keys(state.selectedElementIds || {});
        const cells = api.getSceneElements()
          .filter((el) => ids.includes(el.id) && el.customData?.grid && el.customData?.r != null)
          .map((el) => ({ grid: el.customData.grid, r: el.customData.r, c: el.customData.c }));
        return {
          count: ids.length,
          cells,
          groups: Object.keys(state.selectedGroupIds || {}).length,
          editingGroupId: state.editingGroupId ?? null,
        };
      })()`);

    const firstPick = await cellPoint(2, 1);
    await cdp.clickPoint(firstPick.x, firstPick.y);
    await sleep(320);
    const picked = await selection();
    check(
      "a click on a cell picks that cell alone",
      picked.count === 1 &&
        picked.cells.length === 1 &&
        picked.cells[0].grid === tableGrid &&
        picked.cells[0].r === 2 &&
        picked.cells[0].c === 1 &&
        picked.groups === 0 &&
        !picked.editingGroupId,
      JSON.stringify(picked),
    );

    const nextPick = await cellPoint(1, 2);
    await cdp.clickPoint(nextPick.x, nextPick.y);
    await sleep(320);
    const repicked = await selection();
    check(
      "a click on another cell moves the pick",
      repicked.count === 1 && repicked.cells[0]?.r === 1 && repicked.cells[0]?.c === 2,
      JSON.stringify(repicked),
    );

    const lineGeom = await gridGeom();
    await cdp.clickPoint(lineGeom.table.left + 40, lineGeom.rows[1].top);
    await sleep(360);
    const onLine = await selection();
    check(
      "a press on a table line takes the whole table",
      onLine.count > 1 && onLine.cells.length === onLine.count && onLine.groups >= 1 && !onLine.editingGroupId,
      JSON.stringify({ count: onLine.count, cells: onLine.cells.length, groups: onLine.groups }),
    );

    const clearSpot = await cdp.evaluate(`(() => {
      const r = document.querySelector(".canvas").getBoundingClientRect();
      return { x: r.right - 240, y: r.bottom - 120 };
    })()`);
    await cdp.clickPoint(clearSpot.x, clearSpot.y);
    await sleep(380);
    const cleared = await selection();
    check("a click on empty canvas drops the cell pick", cleared.count === 0, JSON.stringify(cleared));

    /* ------------------------ shift-click a block, merge it, split it back */
    if (!(await cdp.evaluate(`!!document.querySelector(".panel.open")`))) await pickTool("สร้างตาราง");
    const cellCard = () =>
      cdp.evaluate(`(() => {
        const el = document.querySelector(".cell-edits");
        if (!el) return null;
        return {
          hint: el.querySelector(".hint")?.textContent.trim() ?? "",
          buttons: [...el.querySelectorAll("button")].map((b) => ({ text: b.textContent.trim(), disabled: b.disabled })),
        };
      })()`);
    const clickCardButton = async (label) => {
      const box = await cdp.evaluate(`(() => {
        const el = [...document.querySelectorAll(".cell-edits button")]
          .find((b) => b.textContent.trim() === ${JSON.stringify(label)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
      if (!box) throw new Error(`no ${label} button in the cell card`);
      await cdp.clickPoint(box.x, box.y);
      await sleep(460);
    };
    const mergeShape = () =>
      cdp.evaluate(`(() => {
        const cells = window.__boardsApi.getSceneElements().filter(
          (el) => !el.isDeleted && el.customData?.grid === ${JSON.stringify(tableGrid)} && el.customData?.r != null,
        );
        const merged = cells
          .filter((el) => (el.customData.rowSpan || 1) > 1 || (el.customData.colSpan || 1) > 1)
          .map((el) => ({ r: el.customData.r, c: el.customData.c, rowSpan: el.customData.rowSpan || 1, colSpan: el.customData.colSpan || 1 }));
        return { cells: cells.length, merged };
      })()`);

    const alphaPoint = await cellPoint(0, 0);
    await cdp.clickPoint(alphaPoint.x, alphaPoint.y);
    await sleep(280);
    const neighbourPoint = await cellPoint(0, 1);
    await cdp.clickPointWith(neighbourPoint.x, neighbourPoint.y, 8);
    await sleep(340);
    const block = await selection();
    const blockCard = await cellCard();
    const mergeButton = blockCard?.buttons.find((b) => b.text === "รวมช่อง");
    check(
      "shift-click builds a block of cells",
      block.cells.length === 2 && mergeButton?.disabled === false,
      JSON.stringify({ cells: block.cells.length, hint: blockCard?.hint, buttons: blockCard?.buttons }),
    );

    const beforeMerge = await mergeShape();
    await clickCardButton("รวมช่อง");
    const afterMerge = await mergeShape();
    const mergedCard = await cellCard();
    check(
      "merging a block turns it into one cell",
      afterMerge.cells === beforeMerge.cells - 1 &&
        afterMerge.merged.length === 1 &&
        afterMerge.merged[0].r === 0 &&
        afterMerge.merged[0].c === 0 &&
        afterMerge.merged[0].colSpan === 2 &&
        afterMerge.merged[0].rowSpan === 1,
      JSON.stringify({ before: beforeMerge.cells, after: afterMerge }),
    );
    const mergedText = await textCell();
    check(
      "the merged cell keeps the top-left text",
      mergedText?.r === 0 && mergedText?.c === 0,
      JSON.stringify(mergedText),
    );
    check(
      "the panel offers split for a merged cell",
      mergedCard?.buttons.find((b) => b.text === "แยกช่อง")?.disabled === false &&
        mergedCard?.buttons.find((b) => b.text === "รวมช่อง")?.disabled === true,
      JSON.stringify(mergedCard?.buttons),
    );

    await clickCardButton("แยกช่อง");
    const afterSplit = await mergeShape();
    const splitText = await textCell();
    check(
      "splitting the merged cell puts both cells back",
      afterSplit.cells === beforeMerge.cells && afterSplit.merged.length === 0,
      JSON.stringify(afterSplit),
    );
    check(
      "the word stays in its cell through a merge and split",
      splitText?.r === 0 && splitText?.c === 0,
      JSON.stringify(splitText),
    );

    /* a square block merges too, so cells can be merged in both directions */
    const square = [
      [2, 0],
      [2, 1],
      [3, 0],
      [3, 1],
    ];
    for (let i = 0; i < square.length; i += 1) {
      await camSettled();
      const point = await cellPoint(square[i][0], square[i][1]);
      if (i === 0) await cdp.clickPoint(point.x, point.y);
      else await cdp.clickPointWith(point.x, point.y, 8);
      await sleep(260);
    }
    const squareCard = await cellCard();
    await clickCardButton("รวมช่อง");
    const squareMerged = await mergeShape();
    check(
      "a 2 x 2 block merges into one square cell",
      squareMerged.merged.length === 1 &&
        squareMerged.merged[0].rowSpan === 2 &&
        squareMerged.merged[0].colSpan === 2,
      JSON.stringify({ card: squareCard?.buttons, merged: squareMerged.merged }),
    );
    await camSettled();
    const squarePoint = await cellPoint(2, 0);
    await cdp.clickPoint(squarePoint.x, squarePoint.y);
    await sleep(280);
    await clickCardButton("แยกช่อง");
    const squareBack = await mergeShape();
    check(
      "the square cell splits into four again",
      squareBack.cells === beforeMerge.cells && squareBack.merged.length === 0,
      JSON.stringify(squareBack),
    );

    /* ------------------------ a merge survives the table growing around it */
    await camSettled();
    const tallTop = await cellPoint(1, 0);
    await cdp.clickPoint(tallTop.x, tallTop.y);
    await sleep(260);
    const tallBottom = await cellPoint(2, 0);
    await cdp.clickPointWith(tallBottom.x, tallBottom.y, 8);
    await sleep(320);
    await clickCardButton("รวมช่อง");
    const tall = await mergeShape();
    check(
      "a vertical block merges into one tall cell",
      tall.merged.length === 1 &&
        tall.merged[0].r === 1 &&
        tall.merged[0].c === 0 &&
        tall.merged[0].rowSpan === 2 &&
        tall.merged[0].colSpan === 1,
      JSON.stringify(tall),
    );

    // drop a row inside the merged cell: it should stretch, not tear
    await hoverLine("row", 2);
    await waitPill(".grid-add-insert", 2);
    await clickPill(".grid-add-insert");
    await cdp.waitFor(
      `(() => {
        const el = window.__boardsApi.getSceneElements().find(
          (x) => !x.isDeleted && x.customData?.grid === ${JSON.stringify(tableGrid)} && (x.customData.rowSpan || 1) > 1,
        );
        return !!el && el.customData.rowSpan === 3;
      })()`,
      { label: "merged cell stretched to three rows" },
    );
    const stretched = await mergeShape();
    check(
      "a row inserted inside a merged cell stretches it",
      stretched.merged[0]?.rowSpan === 3 && stretched.merged[0]?.colSpan === 1,
      JSON.stringify(stretched.merged),
    );

    await hoverLeftBorder(2);
    await waitPill(".grid-add-row-del", 2);
    await clickPill(".grid-add-row-del");
    await cdp.waitFor(
      `(() => {
        const el = window.__boardsApi.getSceneElements().find(
          (x) => !x.isDeleted && x.customData?.grid === ${JSON.stringify(tableGrid)} && (x.customData.rowSpan || 1) > 1,
        );
        return !!el && el.customData.rowSpan === 2;
      })()`,
      { label: "merged cell back to two rows" },
    );
    const mergedBack = await mergeShape();
    check(
      "removing a row inside the merged cell shrinks it back",
      mergedBack.merged[0]?.rowSpan === 2,
      JSON.stringify(mergedBack.merged),
    );

    await camSettled();
    const tallAgain = await cellPoint(1, 0);
    await cdp.clickPoint(tallAgain.x, tallAgain.y);
    await sleep(300);
    const tallSel = await selection();
    const tallCard = await cellCard();
    await clickCardButton("แยกช่อง");
    const tallSplit = await mergeShape();
    check(
      "the tall cell splits back into two cells",
      tallSplit.cells === beforeMerge.cells && tallSplit.merged.length === 0,
      JSON.stringify({ split: tallSplit, pick: tallSel, card: tallCard, point: tallAgain }),
    );

    /* ------------------------------------------- drag a cell border to size */
    const resizeTarget = () =>
      cdp.evaluate(`(() => {
        const api = window.__boardsApi;
        const cells = api.getSceneElements()
          .filter((el) => el.customData?.grid === ${JSON.stringify(tableGrid)} && el.customData?.r != null && el.customData?.c != null && !el.isDeleted);
        if (!cells.length) return null;
        const s = api.getAppState();
        const zoom = s.zoom?.value || 1;
        const host = document.querySelector(".canvas").getBoundingClientRect();
        const rowTop = new Map();
        const rowBottom = new Map();
        const colLeft = new Map();
        const colRight = new Map();
        for (const el of cells) {
          const r = el.customData.r;
          const c = el.customData.c;
          rowTop.set(r, Math.min(rowTop.get(r) ?? Infinity, el.y));
          rowBottom.set(r, Math.max(rowBottom.get(r) ?? -Infinity, el.y + el.height));
          colLeft.set(c, Math.min(colLeft.get(c) ?? Infinity, el.x));
          colRight.set(c, Math.max(colRight.get(c) ?? -Infinity, el.x + el.width));
        }
        const rows = [...rowTop.keys()].sort((a, b) => a - b).map((r) => ({ r, top: rowTop.get(r), height: rowBottom.get(r) - rowTop.get(r) }));
        const cols = [...colLeft.keys()].sort((a, b) => a - b).map((c) => ({ c, left: colLeft.get(c), width: colRight.get(c) - colLeft.get(c) }));
        const sx = (x) => host.left + (x + (s.scrollX || 0)) * zoom;
        const sy = (y) => host.top + (y + (s.scrollY || 0)) * zoom;
        const left = cols[0].left;
        const top = rows[0].top;
        const right = cols[cols.length - 1].left + cols[cols.length - 1].width;
        const bottom = rows[rows.length - 1].top + rows[rows.length - 1].height;
        return {
          zoom,
          rows: rows.map((r) => ({ r: r.r, height: Math.round(r.height) })),
          cols: cols.map((c) => ({ c: c.c, width: Math.round(c.width) })),
          box: { left: sx(left), top: sy(top), right: sx(right), bottom: sy(bottom) },
          middle: { x: sx(cols[0].left + cols[0].width / 2), y: sy(rows[0].top + rows[0].height / 2) },
          rowBorder: { x: sx(left + Math.min(20, cols[0].width / 2)), y: sy(rows[0].top + rows[0].height) },
          colBorder: { x: sx(cols[0].left + cols[0].width), y: sy(rows[0].top + rows[0].height / 2) },
        };
      })()`);

    const tracksNow = async () => {
      const target = await resizeTarget();
      return { row0: target.rows[0].height, col0: target.cols[0].width, rows: target.rows.length, cols: target.cols.length };
    };
    const beforeResize = await resizeTarget();
    check(
      "the table reports borders to drag",
      Boolean(beforeResize) && beforeResize.rows.length >= 2 && beforeResize.cols.length >= 2,
      JSON.stringify(beforeResize ? { rows: beforeResize.rows.length, cols: beforeResize.cols.length } : null),
    );
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved", x: beforeResize.rowBorder.x, y: beforeResize.rowBorder.y, button: "none", buttons: 0,
    });
    const rowHandle = await cdp.waitFor(
      `(() => {
        const root = document.querySelector(".grid-resize");
        const line = document.querySelector(".grid-resize-line");
        return Boolean(root && line) && root.classList.contains("visible") && line.classList.contains("row");
      })()`,
      { label: "row border handle" },
    );
    const cursors = await cdp.evaluate(`({ row: document.querySelector(".canvas").classList.contains("grid-cursor-row"), col: document.querySelector(".canvas").classList.contains("grid-cursor-col") })`);
    check(
      "a row border turns into a resize handle under the pointer",
      rowHandle && cursors.row && !cursors.col,
      `${JSON.stringify(cursors)}`,
    );
    const rowGrab = beforeResize.rows[0];
    await cdp.dragPoint(beforeResize.rowBorder.x, beforeResize.rowBorder.y, 0, 36);
    const afterRowResize = await cdp.waitFor(
      `(() => {
        const api = window.__boardsApi;
        const cells = api.getSceneElements().filter((el) => el.customData?.grid === ${JSON.stringify(tableGrid)} && el.customData?.r === 0 && el.customData?.c != null && !el.isDeleted);
        if (!cells.length) return false;
        const top = Math.min(...cells.map((el) => el.y));
        const bottom = Math.max(...cells.map((el) => el.y + el.height));
        return Math.round(bottom - top) === ${rowGrab.height + Math.round(36 / beforeResize.zoom)};
      })()`,
      { label: "row border drag committed" },
    );
    const resizedRows = await resizeTarget();
    check(
      "dragging a row border stretches that row only",
      Boolean(afterRowResize) &&
        resizedRows.rows.length === beforeResize.rows.length &&
        Math.abs(resizedRows.rows[0].height - rowGrab.height - 36 / beforeResize.zoom) <= 2 &&
        resizedRows.rows.slice(1).every((row, i) => Math.abs(row.height - beforeResize.rows[i + 1].height) <= 1) &&
        resizedRows.cols.every((col, i) => Math.abs(col.width - beforeResize.cols[i].width) <= 1),
      `row ${rowGrab.height} -> ${resizedRows.rows[0].height} (zoom ${beforeResize.zoom}); sizes ${JSON.stringify(resizedRows.rows.map((r) => r.height))}`,
    );
    const beforeCol = await resizeTarget();
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved", x: beforeCol.colBorder.x, y: beforeCol.colBorder.y, button: "none", buttons: 0,
    });
    const colHandle = await cdp.waitFor(
      `(() => {
        const root = document.querySelector(".grid-resize");
        const line = document.querySelector(".grid-resize-line");
        return Boolean(root && line) && root.classList.contains("visible") && line.classList.contains("col");
      })()`,
      { label: "column border handle" },
    );
    const cursorsCol = await cdp.evaluate(`({ row: document.querySelector(".canvas").classList.contains("grid-cursor-row"), col: document.querySelector(".canvas").classList.contains("grid-cursor-col") })`);
    check(
      "a column border turns into a resize handle under the pointer",
      colHandle && cursorsCol.col && !cursorsCol.row,
      `${JSON.stringify(cursorsCol)}`,
    );
    const colGrab = beforeCol.cols[0];
    await cdp.dragPoint(beforeCol.colBorder.x, beforeCol.colBorder.y, 40, 0);
    await sleep(260);
    const colWidthNow = await cdp.evaluate(`(() => {
      const api = window.__boardsApi;
      const cells = api.getSceneElements().filter((el) => el.customData?.grid === ${JSON.stringify(tableGrid)} && el.customData?.c === 0 && el.customData?.r != null && !el.isDeleted);
      if (!cells.length) return null;
      const left = Math.min(...cells.map((el) => el.x));
      const right = Math.max(...cells.map((el) => el.x + el.width));
      return Math.round((right - left) * 100) / 100;
    })()`);
    check(
      "dragging a column border stretches that column only",
      typeof colWidthNow === "number" &&
        Math.abs(colWidthNow - colGrab.width - 40 / beforeCol.zoom) <= 3,
      `col ${colGrab.width} -> ${colWidthNow} (zoom ${beforeCol.zoom})`,
    );
    const resizedCols = await resizeTarget();
    check(
      "the column drag leaves the other tracks alone",
      resizedCols.cols.length === beforeCol.cols.length &&
        resizedCols.cols.slice(1).every((col, i) => Math.abs(col.width - beforeCol.cols[i + 1].width) <= 1) &&
        resizedCols.rows.every((row, i) => Math.abs(row.height - beforeCol.rows[i].height) <= 1),
      `cols ${JSON.stringify(resizedCols.cols.map((c) => c.width))} rows ${JSON.stringify(resizedCols.rows.map((r) => r.height))}`,
    );
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved", x: resizedCols.middle.x, y: resizedCols.middle.y, button: "none", buttons: 0,
    });
    const hidden = await cdp.waitFor(`!document.querySelector(".grid-resize")?.classList.contains("visible")`, {
      label: "resize handle leaves the cell middle",
    });
    check("the resize handle leaves when the pointer is back inside a cell", hidden, `${hidden}`);

    /* drag both borders back so the rest of the suite sees the table it made */
    const restoreRow = await resizeTarget();
    await cdp.dragPoint(restoreRow.rowBorder.x, restoreRow.rowBorder.y, 0, -36);
    await sleep(200);
    const restoreCol = await resizeTarget();
    await cdp.dragPoint(restoreCol.colBorder.x, restoreCol.colBorder.y, -40, 0);
    await sleep(220);
    const restored = await tracksNow();
    check(
      "dragging a border back restores the track",
      Math.abs(restored.row0 - rowGrab.height) <= 2 &&
        Math.abs(restored.col0 - beforeCol.cols[0].width) <= 2 &&
        restored.rows === beforeCol.rows.length &&
        restored.cols === beforeCol.cols.length,
      JSON.stringify(restored),
    );

    /* -------------------------------------------------------- save status */
    const pillSaved = await cdp.waitFor(
      `document.querySelector(".save-pill")?.classList.contains("saved") === true`,
      { label: "save pill settles on saved" },
    );
    const pill = await cdp.evaluate(`(() => {
      const el = document.querySelector(".save-pill");
      const rect = el.getBoundingClientRect();
      return {
        text: el.querySelector(".save-text")?.textContent || "",
        time: el.querySelector(".save-time")?.textContent || "",
        label: el.getAttribute("aria-label"),
        live: el.getAttribute("aria-live"),
        disabled: el.disabled,
        right: Math.round(rect.right),
        top: Math.round(rect.top),
        viewport: window.innerWidth,
      };
    })()`);
    check(
      "the board says when it was last saved",
      pillSaved && /^บันทึกแล้ว$/.test(pill.text) && /^\d{2}:\d{2}$/.test(pill.time),
      JSON.stringify(pill),
    );
    check(
      "the save pill is announced and not clickable while saved",
      pill.live === "polite" && /บันทึกแล้วเมื่อ/.test(pill.label || "") && pill.disabled === true,
      `${pill.live} / ${pill.label} / disabled=${pill.disabled}`,
    );
    check(
      "the save pill sits in the top-right band, left of Excalidraw's own buttons",
      pill.right > pill.viewport / 2 && pill.top < 60,
      JSON.stringify(pill),
    );
    const pillSaving = await cdp.evaluate(`(() => {
      const api = window.__boardsApi;
      const el = api.getSceneElements()[0];
      if (!el) return "no element";
      api.updateScene({ elements: api.getSceneElementsIncludingDeleted().map((x) => x), appState: { scrollX: api.getAppState().scrollX + 3 } });
      return "queued";
    })()`);
    await cdp.waitFor(`document.querySelector(".save-pill")?.classList.contains("saved") === true`, {
      label: "save settles after the nudge",
    });
    check("a nudge settles back to saved", pillSaving === "queued", pillSaving);

    /* -------------------------------------------------------------- theme */
    const themeLight = await cdp.evaluate(`(() => {
      const toggle = document.querySelector(".theme-toggle");
      const style = getComputedStyle(document.querySelector(".panel") || document.body);
      return {
        attr: document.documentElement.dataset.theme,
        toggle: toggle ? Math.round(toggle.getBoundingClientRect().width) : 0,
        ink: style.color,
      };
    })()`);
    check(
      "theme toggle sits in the top band and the board opens light",
      themeLight.attr === "light" && themeLight.toggle >= 28,
      JSON.stringify(themeLight),
    );
    await cdp.evaluate(`document.querySelector(".theme-toggle").click()`);
    await cdp.waitFor(`document.documentElement.dataset.theme === "dark"`, { label: "dark theme" });
    await sleep(350);
    const themeDark = await cdp.evaluate(`(() => {
      const canvas = getComputedStyle(document.querySelector(".canvas"));
      const body = getComputedStyle(document.body);
      return {
        attr: document.documentElement.dataset.theme,
        canvas: canvas.backgroundColor,
        app: window.__boardsApi.getAppState().theme,
        ink: body.color,
      };
    })()`);
    check(
      "dark theme repaints the page and the editor",
      themeDark.attr === "dark" && themeDark.app === "dark" && themeDark.canvas === "rgb(18, 18, 27)",
      JSON.stringify(themeDark),
    );
    // the flip is saved with the scene, so let the debounce land before reloading
    await cdp.waitFor(
      `fetch("/api/boards/${BOARD}").then((r) => r.json()).then((b) => b.appState?.theme === "dark")`,
      { label: "dark theme saved with the board" },
    );
    await cdp.navigate(`${BASE}/b/${BOARD}`);
    await cdp.waitFor(`!!window.__boardsApi`, { label: "editor after theme reload" });
    await sleep(600);
    const themeReload = await cdp.evaluate(
      `({ attr: document.documentElement.dataset.theme, app: window.__boardsApi.getAppState().theme })`,
    );
    check(
      "the board keeps its dark theme across a reload",
      themeReload.attr === "dark" && themeReload.app === "dark",
      JSON.stringify(themeReload),
    );
    await cdp.evaluate(`document.querySelector(".theme-toggle").click()`);
    await cdp.waitFor(`document.documentElement.dataset.theme === "light"`, { label: "light theme back" });

    await cdp.viewport(393, 852, true);
    await cdp.navigate(`${BASE}/b/${BOARD}`);
    await cdp.waitFor(`!!document.querySelector(".presence") && !document.querySelector(".bar")`, { label: "mobile editor" });
    await sleep(300);
    const mobileBefore = await cdp.evaluate(`(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      appBar: !!document.querySelector(".bar"),
    }))()`);
    check("mobile editor has no horizontal overflow", mobileBefore.overflow <= 1 && !mobileBefore.appBar, JSON.stringify(mobileBefore));

    const cornerGroup = await cdp.evaluate(`(() => {
      const box = (selector) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width) };
      };
      return { theme: box(".theme-toggle"), presence: box(".presence"), docked: !!document.querySelector(".top-actions.docked") };
    })()`);
    check(
      "phone keeps the theme button and avatars in the visible corner",
      cornerGroup.theme &&
        cornerGroup.presence &&
        !cornerGroup.docked &&
        cornerGroup.theme.x + cornerGroup.theme.w <= 393 &&
        cornerGroup.presence.x + cornerGroup.presence.w <= 393,
      JSON.stringify(cornerGroup),
    );

    const mobileOverlay = await cdp.evaluate(`(() => {
      const back = document.querySelector(".back-fab").getBoundingClientRect();
      const canvas = document.querySelector(".canvas").getBoundingClientRect();
      const menu = document.querySelector(".FixedSideContainer_side_top")?.getBoundingClientRect();
      return { backBottom: back.bottom, canvasTop: canvas.top, menuTop: menu ? menu.top : null };
    })()`);
    check(
      "mobile canvas runs under the back button",
      mobileOverlay.canvasTop < mobileOverlay.backBottom - 8 &&
        mobileOverlay.menuTop !== null &&
        mobileOverlay.backBottom <= mobileOverlay.menuTop - 4,
      JSON.stringify(mobileOverlay),
    );

    const mobileTools = await cdp.evaluate(`(() => {
      const tools = document.querySelector(".App-toolbar");
      const r = tools.getBoundingClientRect();
      const back = document.querySelector(".back-fab").getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      return {
        left: r.left, right: r.right, width: r.width, top: r.top, vw,
        backLeft: back.left, backTop: back.top,
      };
    })()`);
    check(
      "mobile drawing tools stay on screen under the corner buttons",
      mobileTools.left >= 0 && mobileTools.right <= mobileTools.vw + 1 &&
        mobileTools.width <= mobileTools.vw && mobileTools.top >= 44,
      JSON.stringify(mobileTools),
    );
    const mobilePresence = await cdp.evaluate(`(() => {
      const p = document.querySelector(".presence");
      const r = p.getBoundingClientRect();
      const table = document.querySelector(".tools-more");
      const tools = document.querySelector(".App-toolbar").getBoundingClientRect();
      const t = table ? table.getBoundingClientRect() : null;
      const vw = document.documentElement.clientWidth;
      return {
        fromRight: vw - r.right, top: r.top, left: r.left,
        display: getComputedStyle(p).display,
        docked: Boolean(p.closest(".layer-ui__wrapper__top-right")),
        parent: p.parentElement.className,
        avatars: p.querySelectorAll(".presence-avatar").length,
        tableInside: Boolean(t && table.closest(".App-toolbar") && t.left >= tools.left - 1 && t.right <= Math.min(tools.right, vw) + 1),
      };
    })()`);
    check(
      "mobile presence stays in the top-right corner",
      mobilePresence.display !== "none" && mobilePresence.fromRight <= 12 && mobilePresence.top <= 12,
      JSON.stringify(mobilePresence),
    );
    check(
      "mobile presence falls back to its own corner pill",
      mobilePresence.docked === false && mobilePresence.parent === "top-actions",
      JSON.stringify(mobilePresence),
    );
    check(
      "phones use Excalidraw's own mobile row without the extra tools button",
      (await cdp.evaluate(`document.querySelectorAll(".App-toolbar .tools-more").length`)) === 0,
      JSON.stringify(mobilePresence),
    );
    check(
      "mobile back button stays in the top-left corner",
      mobileTools.backLeft <= 10 && mobileTools.backTop <= 10,
      JSON.stringify({ left: mobileTools.backLeft, top: mobileTools.backTop }),
    );
    const mobileRow = await cdp.evaluate(`(() => {
      const row = document.querySelector(".App-toolbar");
      const r = row.getBoundingClientRect();
      const back = document.querySelector(".back-fab").getBoundingClientRect();
      const presence = document.querySelector(".presence").getBoundingClientRect();
      return {
        display: getComputedStyle(row).display,
        top: Math.round(r.top),
        fits: r.left >= 0 && r.right <= document.documentElement.clientWidth + 1,
        clearOfCorners: r.top >= Math.max(back.bottom, presence.bottom),
      };
    })()`);
    check(
      "the mobile row keeps its own line under the corner buttons",
      mobileRow.display !== "none" && mobileRow.fits && mobileRow.clearOfCorners,
      JSON.stringify(mobileRow),
    );
    await cdp.viewport(null);

    await cdp.navigate(`${BASE}/b/${BOARD}`);
    await cdp.waitFor(`!!document.querySelector(".presence")`, { label: "presence ready" });
    await sleep(500);
    const live1 = await cdp.evaluate(`document.querySelector(".presence")?.textContent?.trim()`);
    await cdp.navigate(`${BASE}/b/${BOARD}`);
    await cdp.waitFor(`!!document.querySelector(".presence")`, { label: "presence after reload" });
    await sleep(900);
    const live2 = await cdp.evaluate(`document.querySelector(".presence")?.textContent?.trim()`);
    check("presence stays at one peer after reload", /1\s*คน/.test(live1) && /1\s*คน/.test(live2), `${live1} -> ${live2}`);

    // Another client sends a sticky-like text and a pasted image over the board
    // socket. The image binary lives in `files`, outside the element list; if we
    // only merge elements the receiver shows a blank image and loses the file.
    const sender = new WebSocket(`${BASE.replace(/^http/, "ws")}/ws/board/${BOARD}?sid=e2e-sender-1&name=Sender`);
    await new Promise((resolve, reject) => {
      sender.once("open", resolve);
      sender.once("error", reject);
    });
    const before = (await api(`/api/boards/${BOARD}`)).body;
    const stamp = Date.now();
    const stickyRect = {
      id: "e2e-sticky-rect",
      type: "rectangle",
      x: 40,
      y: 320,
      width: 220,
      height: 140,
      angle: 0,
      strokeColor: "#1e1e1e",
      backgroundColor: "#ffec99",
      fillStyle: "solid",
      strokeWidth: 2,
      strokeStyle: "solid",
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: { type: 3 },
      seed: 21,
      version: 1,
      versionNonce: 21,
      isDeleted: false,
      boundElements: [{ type: "text", id: "e2e-sticky-text" }],
      updated: stamp,
      link: null,
      locked: false,
    };
    const stickyText = {
      id: "e2e-sticky-text",
      type: "text",
      x: 60,
      y: 345,
      width: 180,
      height: 28,
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
      seed: 22,
      version: 1,
      versionNonce: 22,
      isDeleted: false,
      boundElements: null,
      updated: stamp,
      link: null,
      locked: false,
      text: "สวัสดีจากอีกเครื่อง",
      fontSize: 20,
      fontFamily: 1,
      textAlign: "left",
      verticalAlign: "top",
      containerId: "e2e-sticky-rect",
      originalText: "สวัสดีจากอีกเครื่อง",
      lineHeight: 1.25,
      baseline: 18,
    };
    const imageFile = {
      id: "e2e-remote-file",
      mimeType: "image/png",
      dataURL: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4m0AAAAASUVORK5CYII=",
      created: stamp,
      lastRetrieved: stamp,
    };
    const image = {
      id: "e2e-remote-image",
      type: "image",
      x: 320,
      y: 320,
      width: 120,
      height: 120,
      angle: 0,
      strokeColor: "transparent",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 2,
      strokeStyle: "solid",
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: null,
      seed: 23,
      version: 1,
      versionNonce: 23,
      isDeleted: false,
      boundElements: null,
      updated: stamp,
      link: null,
      locked: false,
      fileId: imageFile.id,
      status: "saved",
      scale: [1, 1],
      crop: null,
    };
    sender.send(JSON.stringify({
      type: "update",
      scene: {
        ...before,
        elements: [...(before.elements || []), stickyRect, stickyText, image],
        files: { ...(before.files || {}), [imageFile.id]: imageFile },
      },
    }));
    await cdp.waitFor(
      `window.__boardsApi.getSceneElements().some((el) => el.id === "e2e-remote-image")`,
      { label: "remote image element" },
    );
    const remote = await cdp.evaluate(`(() => {
      const api = window.__boardsApi;
      const els = api.getSceneElements();
      const files = api.getFiles() || {};
      return {
        sticky: els.some((el) => el.id === "e2e-sticky-text" && el.text === "สวัสดีจากอีกเครื่อง"),
        image: els.some((el) => el.id === "e2e-remote-image" && el.fileId === "e2e-remote-file"),
        file: Boolean(files["e2e-remote-file"]?.dataURL),
      };
    })()`);
    check("realtime receives a sticky note from another client", remote.sticky, JSON.stringify(remote));
    check("realtime receives a pasted image with its file", remote.image && remote.file, JSON.stringify(remote));
    sender.close();

    /* ----------------------------------------------------------- catalog */
    await cdp.navigate(`${BASE}/`);
    await cdp.waitFor(`!!document.querySelector('.card[data-slug="${BOARD}"]')`, {
      label: "catalog card",
    });
    const catalogGlass = await cdp.evaluate(`(() => {
      const card = document.querySelector('.card[data-slug="${BOARD}"]');
      const header = document.querySelector("header");
      const body = getComputedStyle(document.body).backgroundImage;
      return {
        headerBlur: getComputedStyle(header).backdropFilter || getComputedStyle(header).webkitBackdropFilter,
        cardBlur: getComputedStyle(card).backdropFilter || getComputedStyle(card).webkitBackdropFilter,
        cardBg: getComputedStyle(card).backgroundImage,
        bodyMesh: body.includes("radial-gradient"),
        renameVisible: !!card.querySelector(".rename"),
        shotDecoration: getComputedStyle(document.querySelector(".shot")).textDecorationLine,
      };
    })()`);
    check("catalog has glass header", /blur/.test(catalogGlass.headerBlur || ""), catalogGlass.headerBlur);
    const catalogBrand = await cdp.evaluate(`(() => {
      const img = document.querySelector("header img.brand");
      const icon = document.querySelector('link[rel="icon"]');
      const touch = document.querySelector('link[rel="apple-touch-icon"]');
      const title = document.querySelector("header h1");
      return {
        src: img?.getAttribute("src") || null,
        loaded: img?.naturalWidth || 0,
        left: img ? Math.round(img.getBoundingClientRect().left) : null,
        titleLeft: title ? Math.round(title.getBoundingClientRect().left) : null,
        icon: icon?.getAttribute("href") || null,
        touch: touch?.getAttribute("href") || null,
      };
    })()`);
    check(
      "the catalog wears the app logo and tab icon",
      catalogBrand.loaded >= 64 && catalogBrand.src === "/gallery/logo-64.png" &&
        catalogBrand.left < catalogBrand.titleLeft &&
        catalogBrand.icon === "/gallery/logo-32.png" && catalogBrand.touch === "/gallery/logo-180.png",
      JSON.stringify(catalogBrand),
    );
    // the catalogue follows the saved theme, so frost means "blur + translucent gradient" in either palette
    const cardAlpha = (() => {
      const match = /rgba?\(([^)]+)\)/.exec(catalogGlass.cardBg || "");
      if (!match) return null;
      const parts = match[1].split(",").map((part) => Number.parseFloat(part));
      return parts.length === 4 ? parts[3] : 1;
    })();
    check(
      "catalog cards are frosted",
      /blur/.test(catalogGlass.cardBlur || "") && cardAlpha !== null && cardAlpha < 0.9,
      `${catalogGlass.cardBlur} / ${catalogGlass.cardBg}`,
    );
    check("catalog background has glass mesh", catalogGlass.bodyMesh);
    check("catalog shows rename control", catalogGlass.renameVisible);
    check("catalog placeholder is not underlined", catalogGlass.shotDecoration === "none", catalogGlass.shotDecoration);
    await cdp.screenshot("/tmp/e2e-catalog.png");

    await cdp.click(`.card[data-slug="${BOARD}"] .rename`);
    await cdp.waitFor(`!document.getElementById("rename-modal").hidden`, { label: "rename modal" });
    await cdp.waitFor(`document.activeElement === document.getElementById("rename-input")`, {
      label: "rename input focus",
    });
    const renameFocus = await cdp.evaluate(`(() => {
      const input = document.getElementById("rename-input");
      return { active: document.activeElement === input, value: input.value,
        selected: input.selectionStart === 0 && input.selectionEnd === input.value.length };
    })()`);
    check("catalog rename modal focuses and selects", renameFocus.active && renameFocus.selected, JSON.stringify(renameFocus));
    await cdp.evaluate(`document.getElementById("rename-input").value = ""`);
    await cdp.click("#rename-save");
    await cdp.waitFor(`document.getElementById("rename-note").hidden === false`, {
      label: "empty rename warning",
    });
    const emptyNote = await cdp.evaluate(`document.getElementById("rename-note").textContent`);
    check("catalog rename rejects an empty name", /ชื่อต้องไม่ว่าง/.test(emptyNote), emptyNote);
    check("catalog rename stays open after a bad name", await cdp.evaluate(`!document.getElementById("rename-modal").hidden`));
    await cdp.evaluate(`document.getElementById("rename-input").value = "ชื่อจากแคตตาล็อก"`);
    await cdp.click("#rename-save");
    await cdp.waitFor(`document.getElementById("rename-modal").hidden`, { label: "rename saved" });
    await sleep(250);
    const cardTitle = await cdp.evaluate(`document.querySelector('.card[data-slug="${BOARD}"] h2').textContent`);
    check("catalog card updates after rename", cardTitle === "ชื่อจากแคตตาล็อก", cardTitle);
    check("catalog rename persists to API", (await metaTitle(BOARD)) === "ชื่อจากแคตตาล็อก", await metaTitle(BOARD));

    await cdp.navigate(`${BASE}/b/${BOARD}`);
    await cdp.waitFor(`!!document.querySelector(".presence")`, { label: "editor after catalog rename" });
    const editorTitle = await cdp.evaluate(`document.title`);
    check("editor tab follows the catalog rename", editorTitle.startsWith("ชื่อจากแคตตาล็อก"), editorTitle);
    await cdp.screenshot("/tmp/e2e-editor.png");

    await cdp.navigate(`${BASE}/`);
    await cdp.waitFor(`!!document.getElementById("q")`, { label: "catalog search" });
    await cdp.click("#q");
    await cdp.type("ชื่อจากแคตตาล็อก");
    await sleep(350);
    const search = await cdp.evaluate(`(() => {
      const cards = [...document.querySelectorAll(".card")];
      const visible = cards.filter((c) => !c.hidden && getComputedStyle(c).display !== "none");
      return { total: cards.length, visible: visible.length, slugs: visible.map((c) => c.dataset.slug) };
    })()`);
    check("catalog search finds the renamed board", search.visible === 1 && search.slugs[0] === BOARD, JSON.stringify(search));

    /* one board, several หมวดหมู่: it becomes a card in every section */
    await cdp.click("#q");
    // React keeps its own value tracker, so a bare el.value = "" is ignored and
    // the search would keep filtering everything below (sections look ungrouped)
    await cdp.evaluate(`(() => {
      const input = document.getElementById("q");
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(input, "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await cdp.waitFor(`document.getElementById("q").value === "" && document.querySelectorAll(".card:not([hidden])").length > 1`, {
      label: "search cleared",
      timeout: 4000,
    }).catch(() => null);
    const groupTag = `${Date.now()}`;
    const groupOne = (await api("/api/groups", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: `e2e-a-${groupTag}`, color: "violet" }),
    })).body.group;
    const groupTwo = (await api("/api/groups", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: `e2e-b-${groupTag}`, color: "teal" }),
    })).body.group;
    groupsToDrop.push(groupOne.id, groupTwo.id);
    const filed = await api(`/api/boards/${encodeURIComponent(BOARD)}/meta`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ groupIds: [groupOne.id, groupTwo.id] }),
    });
    check(
      "a board can be filed in two groups at once",
      filed.status === 200 && JSON.stringify(filed.body.groupIds) === JSON.stringify([groupOne.id, groupTwo.id]),
      JSON.stringify(filed.body),
    );
    await cdp.navigate(`${BASE}/`);
    await cdp.waitFor(`!!document.querySelector('#group-chips .chip[data-group="${groupOne.id}"]')`, {
      label: "group chips",
    });
    // the catalogue paints the cards from its cached list first and re-files them
    // once /api/boards answers, so wait for the second copy instead of racing it
    await cdp
      .waitFor(`document.querySelectorAll('.card[data-slug="${BOARD}"]').length === 2`, {
        label: "the board filed under both groups",
        timeout: 6000,
      })
      .catch(() => null);
    const multi = await cdp.evaluate(`(() => {
      const copies = [...document.querySelectorAll('.card[data-slug="${BOARD}"]')];
      const sections = [...document.querySelectorAll(".board-section")].filter((s) =>
        s.querySelector('.card[data-slug="${BOARD}"]'));
      const trigger = copies[0]?.querySelector(".card-group");
      return {
        copies: copies.length,
        sections: sections.map((s) => s.dataset.group).sort(),
        label: trigger?.querySelector(".lbl")?.textContent.trim() || null,
        expanded: trigger?.getAttribute("aria-expanded") || null,
        ungrouped: Boolean(document.querySelector('.board-section[data-group="__none__"] .card[data-slug="${BOARD}"]')),
      };
    })()`);
    check(
      "the catalogue shows it under both groups and not ungrouped",
      multi.copies === 2 &&
        JSON.stringify(multi.sections) === JSON.stringify([groupOne.id, groupTwo.id].sort()) &&
        multi.ungrouped === false,
      JSON.stringify(multi),
    );
    check("the card says how many groups it holds", multi.label === "2 หมวด", multi.label);
    await cdp.screenshot("/tmp/e2e-catalog-multi.png");

    /* the popover edits membership: untick the second group */
    await cdp.click(`.card[data-slug="${BOARD}"] .card-group`);
    await cdp.waitFor(
      `!document.querySelector('.card[data-slug="${BOARD}"] .group-menu').hidden`,
      { label: "group menu open" },
    );
    const menu = await cdp.evaluate(`(() => {
      const menu = document.querySelector('.card[data-slug="${BOARD}"] .group-menu');
      return { boxes: [...menu.querySelectorAll('input[type=checkbox]')].map((b) => ({ id: b.value, checked: b.checked })) };
    })()`);
    check(
      "the menu lists every group with the current ticks",
      menu.boxes.some((b) => b.id === groupOne.id && b.checked) &&
        menu.boxes.some((b) => b.id === groupTwo.id && b.checked) &&
        menu.boxes.some((b) => !b.checked),
      JSON.stringify(menu),
    );
    await cdp.evaluate(`(() => {
      const box = document.querySelector('.card[data-slug="${BOARD}"] .group-menu input[value="${groupTwo.id}"]');
      box.click();
    })()`);
    await cdp.waitFor(`document.querySelectorAll('.card[data-slug="${BOARD}"]').length === 1`, {
      label: "one section left",
      timeout: 8000,
    });
    const afterUntick = await api(`/api/boards/${encodeURIComponent(BOARD)}/meta`);
    check(
      "unticking a group stores the remaining membership",
      JSON.stringify(afterUntick.body.groupIds) === JSON.stringify([groupOne.id]),
      JSON.stringify(afterUntick.body),
    );
    const leftLabel = await cdp.evaluate(`document.querySelector('.card[data-slug="${BOARD}"] .card-group .lbl').textContent.trim()`);
    check("the card names its single remaining group", leftLabel === `e2e-a-${groupTag}`, leftLabel);

    await api(`/api/boards/${encodeURIComponent(BOARD)}/meta`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ groupIds: [] }),
    });
    await api(`/api/groups/${encodeURIComponent(groupOne.id)}`, { method: "DELETE" });
    await api(`/api/groups/${encodeURIComponent(groupTwo.id)}`, { method: "DELETE" });
    groupsToDrop = [];

    await cdp.viewport(393, 852, true);
    await cdp.navigate(`${BASE}/`);
    await cdp.waitFor(`!!document.querySelector(".card")`, { label: "mobile catalog" });
    const mobileCatalog = await cdp.evaluate(`(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      headerVisible: !!document.querySelector("header"),
      cardWidth: document.querySelector(".card").getBoundingClientRect().width,
    }))()`);
    check("mobile catalog has no horizontal overflow", mobileCatalog.overflow <= 1, JSON.stringify(mobileCatalog));
    await cdp.screenshot("/tmp/e2e-catalog-mobile.png");
    await cdp.viewport(null);

    deleteProbe = `e2e-delete-${Date.now()}`;
    await api("/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: deleteProbe }),
    });
    await cdp.navigate(`${BASE}/`);
    await cdp.waitFor(`!!document.querySelector('[data-slug="${deleteProbe}"]')`, {
      label: "delete probe card",
    });
    await cdp.click(`[data-slug="${deleteProbe}"] .del`);
    await cdp.waitFor(`!document.getElementById("del-modal").hidden`, {
      label: "delete modal",
    });
    await cdp.hold("#del-hold", 1350);
    await cdp.waitFor(`!document.querySelector('[data-slug="${deleteProbe}"]')`, {
      label: "card removed after hold",
    });
    const deleted = await api(`/api/boards/${encodeURIComponent(deleteProbe)}`);
    check("hold-to-confirm deletes a board", deleted.status === 404, `API ${deleted.status}`);
    deleteProbe = null;

    /* ------------------------------------------------ ER tool: classes and links */
    const REL_BOARD = "e2e-rel-probe";
    await deleteBoard(REL_BOARD);
    const relCreated = await api("/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: REL_BOARD }),
    });
    check(
      "relation probe board created",
      relCreated.status === 200 || relCreated.status === 201,
      `API ${relCreated.status}`,
    );
    await openEditor(REL_BOARD);
    await sleep(500);

    const classScene = () =>
      cdp.evaluate(`(() => {
        const api = window.__boardsApi;
        const els = api.getSceneElements().filter((el) => !el.isDeleted);
        return {
          classes: new Set(els.filter((el) => el.customData?.class && el.customData?.frame).map((el) => el.customData.grid)).size,
          grids: new Set(els.filter((el) => el.customData?.frame).map((el) => el.customData.grid)).size,
          arrows: els.filter((el) => el.type === "arrow").length,
        };
      })()`);

    // the ER panel's own action button, found by its Thai label
    const erButton = (label) =>
      `[...document.querySelectorAll(".er-panel .panel-body button.btn")].find((b) => b.textContent.trim() === ${JSON.stringify(label)})`;
    const openErPanel = async () => {
      if (await cdp.evaluate(`!!document.querySelector(".er-panel.open")`)) return;
      await pickTool("ER diagram");
      await cdp.waitFor(`document.querySelector(".er-panel")?.classList.contains("open")`, { label: "ER panel open" });
    };

    await pickTool("ER diagram");
    await cdp.waitFor(`document.querySelector(".er-panel")?.classList.contains("open")`, { label: "ER panel" });
    const erRow = await toolRowState("ER diagram");
    const emptyScene = await classScene();
    check(
      "ER diagram is a tool of its own with its own panel",
      erRow?.checked === "true" && emptyScene.classes === 0,
      `${JSON.stringify(erRow)} / ${JSON.stringify(emptyScene)}`,
    );

    await cdp.evaluate(`(${erButton("+ class ใหม่")}).click()`);
    await cdp.waitFor(`window.__boardsApi.getSceneElements().some((el) => el.customData?.class && el.customData?.frame && !el.isDeleted)`, {
      label: "ER class inserted",
    });
    await cdp.waitFor(
      `(() => {
         const btn = document.querySelector(".er-panel.open .panel-head .icon-btn");
         if (!btn) return false;
         const r = btn.getBoundingClientRect();
         return r.left >= 0 && r.right <= window.innerWidth && r.top >= 0 && r.bottom <= window.innerHeight;
       })()`,
      { label: "ER panel slid into view" },
    );
    const placed = await classScene();
    check("the ER panel places a class node", placed.classes === 1 && placed.arrows === 0, JSON.stringify(placed));
    await cdp.click(".er-panel .panel-head .icon-btn");
    await cdp.waitFor(`!document.querySelector(".er-panel.open")`, { label: "ER panel closed" });
    await sleep(300);

    /* a class grows its field rows from the + handle; it offers no column */
    const firstClassGrid = await cdp.evaluate(`(() => {
      const frame = window.__boardsApi.getSceneElements().find((el) => el.customData?.class && el.customData?.frame && !el.isDeleted);
      return frame?.customData?.grid || null;
    })()`);
    const classFields = () =>
      cdp.evaluate(`(() => {
        const frame = window.__boardsApi.getSceneElements().find((el) => el.customData?.grid === ${JSON.stringify("__GRID__")} && el.customData?.class && el.customData?.frame && !el.isDeleted);
        return frame?.customData?.classData?.fields?.length ?? -1;
      })()`.replace("__GRID__", firstClassGrid));
    const fieldsBefore = await classFields();
    /* the class's first row boundary is the top of its second line */
    const classLine = async (k) => {
      const point = await cdp.evaluate(`(() => {
        const api = window.__boardsApi;
        const frame = api.getSceneElements().find((el) => el.customData?.grid === ${JSON.stringify("__GRID__")} && el.customData?.frame && !el.isDeleted);
        const lines = api.getSceneElements()
          .filter((el) => el.type === "text" && !el.isDeleted && el.customData?.grid === ${JSON.stringify("__GRID__")} && el.customData?.classLine)
          .sort((a, b) => a.y - b.y);
        if (!frame || lines.length < ${k + 1}) return null;
        const s = api.getAppState();
        const zoom = s.zoom?.value || 1;
        const host = document.querySelector(".canvas").getBoundingClientRect();
        return {
          x: host.left + (frame.x + frame.width / 2 + (s.scrollX || 0)) * zoom,
          y: host.top + (lines[${k}].y + (s.scrollY || 0)) * zoom,
          lines: lines.length,
        };
      })()`.replace(/__GRID__/g, firstClassGrid));
      if (!point) throw new Error(`class has no line ${k}`);
      await moveTo(point.x, point.y);
      return point;
    };
    /* a class has no cells: its removals live on the side border, level with the
       field/method line they drop */
    const classEdge = async (k) => {
      const point = await cdp.evaluate(`(() => {
        const api = window.__boardsApi;
        const frame = api.getSceneElements().find((el) => el.customData?.grid === ${JSON.stringify("__GRID__")} && el.customData?.frame && !el.isDeleted);
        const lines = api.getSceneElements()
          .filter((el) => el.type === "text" && !el.isDeleted && el.customData?.grid === ${JSON.stringify("__GRID__")} && el.customData?.classLine)
          .sort((a, b) => a.y - b.y);
        if (!frame || lines.length < ${k + 1}) return null;
        const s = api.getAppState();
        const zoom = s.zoom?.value || 1;
        const host = document.querySelector(".canvas").getBoundingClientRect();
        return {
          x: host.left + (frame.x + (s.scrollX || 0)) * zoom,
          y: host.top + (lines[${k}].y + lines[${k}].height / 2 + (s.scrollY || 0)) * zoom,
        };
      })()`.replace(/__GRID__/g, firstClassGrid));
      if (!point) throw new Error(`class has no edge at line ${k}`);
      await moveTo(point.x, point.y);
      return point;
    };
    await classLine(1);
    await cdp.waitFor(`Number(getComputedStyle(document.querySelector(".grid-add-insert")).opacity) > 0.5`, {
      label: "class line insert pill",
    });
    const classLinePills = await pills();
    check(
      "a class offers an insert on its line and no column pill",
      classLinePills.insert?.visible === true &&
        classLinePills.insert.axis === "row" &&
        classLinePills.insert.label === "แทรกแถวหรือคอลัมน์ตรงเส้นนี้" &&
        classLinePills.row?.visible === false &&
        classLinePills.col?.visible === false,
      JSON.stringify(classLinePills),
    );
    await clickPill(".grid-add-insert");
    await cdp.waitFor(`(() => {
      const frame = window.__boardsApi.getSceneElements().find((el) => el.customData?.grid === ${JSON.stringify("__GRID__")} && el.customData?.class && el.customData?.frame && !el.isDeleted);
      return (frame?.customData?.classData?.fields?.length || 0) === ${fieldsBefore + 1};
    })()`.replace("__GRID__", firstClassGrid), { label: "class grew a field row" });
    check("+ on a class line inserts a field", (await classFields()) === fieldsBefore + 1, `${fieldsBefore} fields`);

    await classEdge(1);
    await waitPill(".grid-add-row-del", 1);
    const classCellPills = await pills();
    check(
      "a class border offers only the row removal",
      classCellPills.row?.visible === true &&
        classCellPills.row.label === "ลบแถวที่ชี้" &&
        classCellPills.col?.visible === false &&
        classCellPills.insert?.visible === false,
      JSON.stringify(classCellPills),
    );
    await clickPill(".grid-add-row-del");
    await cdp.waitFor(`(() => {
      const frame = window.__boardsApi.getSceneElements().find((el) => el.customData?.grid === ${JSON.stringify("__GRID__")} && el.customData?.class && el.customData?.frame && !el.isDeleted);
      return (frame?.customData?.classData?.fields?.length || 0) === ${fieldsBefore};
    })()`.replace("__GRID__", firstClassGrid), { label: "class lost a field row" });
    check("- on a class border drops that field", (await classFields()) === fieldsBefore, `${fieldsBefore} fields`);

    /* two classes picked together are linked — never cloned */
    await openErPanel();
    await cdp.evaluate(`(${erButton("+ class ใหม่")}).click()`);
    await cdp.waitFor(`(() => {
      const els = window.__boardsApi.getSceneElements().filter((el) => !el.isDeleted);
      return new Set(els.filter((el) => el.customData?.class && el.customData?.frame).map((el) => el.customData.grid)).size === 2;
    })()`, { label: "second class inserted" });
    await cdp.evaluate(`(() => {
      const api = window.__boardsApi;
      const frames = api.getSceneElements().filter((el) => el.customData?.class && el.customData?.frame && !el.isDeleted);
      const selectedElementIds = {};
      for (const frame of frames) selectedElementIds[frame.id] = true;
      api.updateScene({ appState: { selectedElementIds } });
      return frames.length;
    })()`);
    await cdp.waitFor(`(() => { const b = (${erButton("เชื่อม 2 class")}); return !!b && !b.disabled; })()`, {
      label: "connect two classes enabled",
    });
    const beforeLink = await classScene();
    await cdp.evaluate(`(${erButton("เชื่อม 2 class")}).click()`);
    await cdp.waitFor(`window.__boardsApi.getSceneElements().some((el) => el.type === "arrow" && el.customData?.relation)`, {
      label: "relation between two classes",
    });
    await sleep(400);
    const linked = await classScene();
    check(
      "linking two classes draws one arrow and clones nothing",
      linked.classes === 2 && linked.grids === 2 && linked.arrows === 1,
      `${JSON.stringify(beforeLink)} -> ${JSON.stringify(linked)}`,
    );
    const relation = await cdp.evaluate(`(() => {
      const api = window.__boardsApi;
      const els = api.getSceneElements();
      const arrow = els.find((el) => el.type === "arrow" && el.customData?.relation);
      const from = arrow.customData.relation.fromGrid;
      const to = arrow.customData.relation.toGrid;
      const frame = (grid) => els.find((el) => el.customData?.class && el.customData?.frame && el.customData.grid === grid);
      const fromFrame = frame(from);
      const toFrame = frame(to);
      return {
        from,
        to,
        heads: [arrow.startArrowhead, arrow.endArrowhead],
        start: arrow.startBinding?.elementId,
        end: arrow.endBinding?.elementId,
        fromBound: (fromFrame?.boundElements || []).some((b) => b.id === arrow.id),
        toBound: (toFrame?.boundElements || []).some((b) => b.id === arrow.id),
      };
    })()`);
    check(
      "the relation arrow binds both class frames",
      relation.start === `${relation.from}-frame` &&
        relation.end === `${relation.to}-frame` &&
        relation.fromBound &&
        relation.toBound,
      JSON.stringify(relation),
    );
    check(
      "a new ER relation starts as 1:1",
      relation.heads[0] === "crowfoot_one" && relation.heads[1] === "crowfoot_one",
      String(relation.heads),
    );

    await cdp.evaluate(`(() => {
      const api = window.__boardsApi;
      const arrow = api.getSceneElements().find((el) => el.type === "arrow" && el.customData?.relation);
      api.scrollToContent(arrow, { fitToContent: true, animate: false });
      return true;
    })()`);
    await sleep(300);
    const arrowPoint = await cdp.evaluate(`(() => {
      const api = window.__boardsApi;
      const s = api.getAppState();
      const zoom = s.zoom?.value || 1;
      const host = document.querySelector(".canvas").getBoundingClientRect();
      const arrow = api.getSceneElements().find((el) => el.type === "arrow" && el.customData?.relation);
      const first = arrow.points[0];
      const last = arrow.points[arrow.points.length - 1];
      return {
        x: host.left + (arrow.x + (first[0] + last[0]) / 2 + (s.scrollX || 0)) * zoom,
        y: host.top + (arrow.y + (first[1] + last[1]) / 2 + (s.scrollY || 0)) * zoom,
      };
    })()`);
    await cdp.clickPoint(arrowPoint.x, arrowPoint.y);
    await cdp.waitFor(
      `document.querySelector(".relation-panel") && getComputedStyle(document.querySelector(".relation-panel")).visibility === "visible"`,
      { label: "relation panel" },
    );
    const relationPanel = await cdp.evaluate(`(() => ({
      title: document.querySelector(".relation-title")?.textContent,
      options: [...document.querySelectorAll(".relation-option")].map((b) => b.dataset.preset),
      pressed: document.querySelector('.relation-option[data-preset="one-one"]')?.getAttribute("aria-pressed"),
    }))()`);
    check(
      "clicking the relation opens four presets",
      relationPanel.title === "ความสัมพันธ์" &&
        relationPanel.pressed === "true" &&
        relationPanel.options.join() === "one-one,one-many,many-one,many-many",
      JSON.stringify(relationPanel),
    );
    await cdp.click('.relation-option[data-preset="many-many"]');
    await cdp.waitFor(`(() => {
      const a = window.__boardsApi.getSceneElements().find((el) => el.type === "arrow" && el.customData?.relation);
      return a.startArrowhead === "crowfoot_many" && a.endArrowhead === "crowfoot_many";
    })()`, { label: "many-to-many heads" });
    const heads = await cdp.evaluate(`(() => {
      const a = window.__boardsApi.getSceneElements().find((el) => el.type === "arrow" && el.customData?.relation);
      return [a.startArrowhead, a.endArrowhead];
    })()`);
    const normalised = await cdp.evaluate(`(() => {
      const arrows = window.__boardsApi.getSceneElements().filter((el) => el.type === "arrow" && !el.isDeleted);
      return arrows.every((el) => el.points[0][0] === 0 && el.points[0][1] === 0);
    })()`);
    check("relation arrows keep Excalidraw's normalised points", normalised === true, String(normalised));

    check(
      "N:N sets both crowfoot heads",
      heads[0] === "crowfoot_many" && heads[1] === "crowfoot_many",
      String(heads),
    );
    await cdp.screenshot("/tmp/e2e-relations.png");

    await openEditor(REL_BOARD);
    await cdp.waitFor(`(() => {
      const a = window.__boardsApi?.getSceneElements().find((el) => el.type === "arrow" && el.customData?.relation);
      return !!a && a.startArrowhead === "crowfoot_many" && a.endArrowhead === "crowfoot_many";
    })()`, { label: "relation persisted after reload" });
    const persisted = await cdp.evaluate(`(() => {
      const api = window.__boardsApi;
      const els = api.getSceneElements().filter((el) => !el.isDeleted);
      const a = els.find((el) => el.type === "arrow" && el.customData?.relation);
      return {
        classes: new Set(els.filter((el) => el.customData?.class && el.customData?.frame).map((el) => el.customData.grid)).size,
        arrows: els.filter((el) => el.type === "arrow").length,
        heads: [a?.startArrowhead, a?.endArrowhead],
        bound: (a?.startBinding?.elementId || "").endsWith("-frame"),
      };
    })()`);
    check(
      "ER classes and their relation persist after reload",
      persisted.classes === 2 &&
        persisted.arrows === 1 &&
        persisted.heads[0] === "crowfoot_many" &&
        persisted.heads[1] === "crowfoot_many" &&
        persisted.bound,
      JSON.stringify(persisted),
    );
    await deleteBoard(REL_BOARD);
    // Excalidraw 0.18 still registers window.unload; Chrome 158 reports the
    // deprecation as a console error even though our app uses pagehide instead.
    const unloadNoise = /Permissions policy violation: unload is not allowed/;
    const ignored = cdp.consoleErrors.filter((text) => unloadNoise.test(text));
    const realErrors = cdp.consoleErrors.filter((text) => !unloadNoise.test(text));
    if (ignored.length) console.log(`NOTE  ignored ${ignored.length} Excalidraw unload-deprecation console messages`);
    check("no browser console errors", realErrors.length === 0, realErrors.slice(0, 4).join(" | "));
  } catch (error) {
    check("e2e harness completed", false, error.stack || error.message);
  } finally {
    try {
      await deleteBoard(BOARD);
      await deleteBoard("e2e-rel-probe");
      if (deleteProbe) await deleteBoard(deleteProbe);
    } catch {
      /* ignore */
    }
    try {
      cdp?.ws.close();
    } catch {
      /* ignore */
    }
    try {
      browser?.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    await sleep(250);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }

  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("\nFailures:");
    for (const item of failed) console.log(`- ${item.name}: ${item.detail}`);
    process.exit(1);
  }
})();
