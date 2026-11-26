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
        this.consoleErrors.push(message.params.entry.text);
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
  await api(`/api/boards/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
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

async function openEditor(boardId = BOARD) {
  await cdp.navigate(`${BASE}/b/${boardId}`);
  await cdp.waitFor(
    `!!window.__boardsApi && !!document.querySelector(".presence") && !!document.querySelector(".tools-table") && !document.querySelector(".bar") && !document.body.textContent.includes("กำลังโหลดกระดาน")`,
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
      const grip = tools?.querySelector(".tools-grip");
      const fold = tools?.querySelector(".tools-fold");
      const r = tools?.getBoundingClientRect();
      return {
        exists: !!tools,
        floating: tools?.classList.contains("tools-floating") || false,
        position: tools ? getComputedStyle(tools).position : null,
        grip: !!grip,
        fold: !!fold,
        left: r?.left ?? null,
        top: r?.top ?? null,
        bottom: r?.bottom ?? null,
        width: r?.width ?? 0,
        mid: r ? Math.round(r.top + r.height / 2) : null,
        backMid: (() => { const b = document.querySelector(".back-fab").getBoundingClientRect(); return Math.round(b.top + b.height / 2); })(),
        presenceLeft: Math.round(document.querySelector(".presence").getBoundingClientRect().left),
      };
    })()`);
    check(
      "drawing tools are a separate floating island on the same line",
      toolsBefore.exists && toolsBefore.floating && toolsBefore.position === "fixed" &&
        toolsBefore.grip && toolsBefore.fold &&
        Math.abs(toolsBefore.mid - toolsBefore.backMid) <= 2 &&
        toolsBefore.left + toolsBefore.width <= toolsBefore.presenceLeft,
      JSON.stringify(toolsBefore),
    );

    await cdp.drag(".tools-grip", 70, 40);
    await sleep(200);
    const toolsAfter = await cdp.evaluate(`(() => {
      const r = document.querySelector(".App-toolbar").getBoundingClientRect();
      const saved = JSON.parse(localStorage.getItem("boards-tools") || "null");
      return { left: r.left, top: r.top, vw: innerWidth, vh: innerHeight, w: r.width, h: r.height, saved };
    })()`);
    check(
      "drawing tools can be dragged and remember their spot",
      toolsAfter.left > toolsBefore.left + 30 && toolsAfter.top > toolsBefore.top + 20 &&
        toolsAfter.left + toolsAfter.w <= toolsAfter.vw && toolsAfter.top + toolsAfter.h <= toolsAfter.vh &&
        !!toolsAfter.saved,
      JSON.stringify({ toolsBefore, toolsAfter }),
    );

    const gripCursor = await cdp.evaluate(
      `getComputedStyle(document.querySelector(".tools-grip")).cursor`,
    );
    check("the grip advertises that it moves the toolbar", gripCursor === "grab", gripCursor);

    const blankSpot = await cdp.evaluate(`(() => {
      const tools = document.querySelector(".App-toolbar.tools-floating");
      const r = tools.getBoundingClientRect();
      for (let dx = Math.round(r.width) - 1; dx > 0; dx -= 1) {
        const hit = document.elementFromPoint(r.left + dx, r.top + r.height / 2);
        if (hit === tools) return { x: r.left + dx, y: r.top + r.height / 2, left: r.left, top: r.top };
      }
      return null;
    })()`);
    let surfaceMoved = false;
    if (blankSpot) {
      await cdp.dragPoint(blankSpot.x, blankSpot.y, -60, 45);
      await sleep(200);
      surfaceMoved = await cdp.evaluate(`(() => {
        const r = document.querySelector(".App-toolbar.tools-floating").getBoundingClientRect();
        return Math.abs(r.left - (${blankSpot.left} - 60)) <= 2 && Math.abs(r.top - (${blankSpot.top} + 45)) <= 2;
      })()`);
    }
    check(
      "the island can be dragged from its empty surface, not only the grip",
      Boolean(blankSpot) && surfaceMoved,
      JSON.stringify({ blankSpot, surfaceMoved }),
    );

    await cdp.click(".tools-fold");
    await cdp.waitFor(`document.querySelector(".shell").classList.contains("tools-collapsed")`, {
      label: "tools fold",
    });
    const toolsFolded = await cdp.evaluate(`(() => {
      const tools = document.querySelector(".App-toolbar");
      const launcher = document.querySelector(".tools-launcher");
      return {
        display: getComputedStyle(tools).display,
        launcher: !!launcher,
        launcherLabel: launcher?.getAttribute("aria-label") || null,
      };
    })()`);
    check(
      "drawing tools fold into a launcher",
      toolsFolded.display === "none" && toolsFolded.launcher &&
        toolsFolded.launcherLabel === "แสดงเครื่องมือวาด",
      JSON.stringify(toolsFolded),
    );
    const pillBefore = await cdp.evaluate(`(() => {
      const pill = document.querySelector(".tools-launcher");
      const r = pill.getBoundingClientRect();
      return { left: r.left, top: r.top, cursor: getComputedStyle(pill).cursor };
    })()`);
    await cdp.drag(".tools-launcher", -120, 160);
    await sleep(250);
    const pillAfter = await cdp.evaluate(`(() => {
      const pill = document.querySelector(".tools-launcher");
      const r = pill.getBoundingClientRect();
      return {
        left: r.left,
        top: r.top,
        stillFolded: document.querySelector(".shell").classList.contains("tools-collapsed"),
        saved: JSON.parse(localStorage.getItem("boards-tools") || "null"),
      };
    })()`);
    check(
      "the folded pill can be dragged around and stays folded",
      pillBefore.cursor === "grab" && pillAfter.stillFolded &&
        Math.abs(pillAfter.left - (pillBefore.left - 120)) <= 2 &&
        Math.abs(pillAfter.top - (pillBefore.top + 160)) <= 2 &&
        !!pillAfter.saved,
      JSON.stringify({ pillBefore, pillAfter }),
    );

    await cdp.click(".tools-launcher");
    await cdp.waitFor(`!document.querySelector(".shell").classList.contains("tools-collapsed")`, {
      label: "tools unfold",
    });
    const unfoldedAt = await cdp.evaluate(`(() => {
      const r = document.querySelector(".App-toolbar.tools-floating").getBoundingClientRect();
      return { left: r.left, top: r.top };
    })()`);
    check(
      "unfolding puts the row where the pill was",
      Math.abs(unfoldedAt.left - pillAfter.left) <= 2 && Math.abs(unfoldedAt.top - pillAfter.top) <= 2,
      JSON.stringify({ pillAfter, unfoldedAt }),
    );
    check(
      "the launcher brings the drawing tools back",
      (await cdp.evaluate(`getComputedStyle(document.querySelector(".App-toolbar")).display`)) !== "none",
    );
    await cdp.evaluate(`document.querySelector(".tools-grip").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))`);
    await sleep(250);

    const tablePlacement = await cdp.evaluate(`(() => {
      const table = document.querySelector(".tools-table");
      const stack = document.querySelector(".App-toolbar .Stack_horizontal");
      const tools = document.querySelector(".App-toolbar").getBoundingClientRect();
      const native = document.querySelector(".App-toolbar .ToolIcon_size_medium")?.getBoundingClientRect();
      const r = table ? table.getBoundingClientRect() : null;
      return {
        inStack: Boolean(stack && table && stack.contains(table)),
        insideTools: Boolean(r && r.left >= tools.left - 1 && r.right <= tools.right + 1),
        w: r ? r.width : null, h: r ? r.height : null,
        nativeW: native ? native.width : null, nativeH: native ? native.height : null,
        label: table ? table.getAttribute("aria-label") : null,
      };
    })()`);
    check("table button moved into the drawing tools row", tablePlacement.inStack && tablePlacement.insideTools, JSON.stringify(tablePlacement));
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
      "the board tools (table, ER, minimap, lasso) share the slot and stay inside the row",
      boardButtons.count === 4 && boardButtons.all.every((b) => b.inside && b.w > 20),
      JSON.stringify(boardButtons),
    );
    check(
      "table button matches the native tool size",
      Math.abs((tablePlacement.w ?? 0) - (tablePlacement.nativeW ?? 29)) < 1.5 &&
        Math.abs((tablePlacement.h ?? 0) - (tablePlacement.nativeH ?? 29)) < 1.5,
      JSON.stringify(tablePlacement),
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
    await cdp.click(".tools-table");
    await cdp.waitFor(`document.querySelector(".panel")?.classList.contains("open")`, {
      label: "table panel open",
    });
    await cdp.waitFor(`(() => {
      const p = document.querySelector(".panel");
      const r = p.getBoundingClientRect();
      return r.right <= innerWidth + 1 && r.left >= 0;
    })()`, { label: "table panel slides in" });
    const tableActive = await cdp.evaluate(`(() => {
      const t = document.querySelector(".tools-table");
      return { active: t.classList.contains("active"), pressed: t.getAttribute("aria-pressed"), bg: getComputedStyle(t).backgroundColor };
    })()`);
    check(
      "drawing tools button shows the open panel",
      tableActive.active && tableActive.pressed === "true" && /rgba\(99, 96, 217/.test(tableActive.bg),
      JSON.stringify(tableActive),
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
      "drawing tools button clears when the panel closes",
      (await cdp.evaluate(`document.querySelector(".tools-table").classList.contains("active")`)) === false,
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
      const table = document.querySelector(".tools-table");
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
      "phones use Excalidraw's own mobile row without the board buttons",
      (await cdp.evaluate(`document.querySelectorAll(".App-toolbar .tools-table").length`)) === 0,
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

    /* ------------------------------------------------ table relations */
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

    await cdp.click(".tools-er");
    await cdp.waitFor(`document.querySelector(".er-panel.open")`, { label: "ER panel" });
    await cdp.waitFor(`window.__boardsApi.getSceneElements().some((el) => el.customData?.class && el.customData?.frame && !el.isDeleted)`, {
      label: "ER class inserted",
    });
    await cdp.click(".er-panel .panel-head .icon-btn");
    await cdp.waitFor(`!document.querySelector(".er-panel.open")`, { label: "ER panel closed" });
    await sleep(400);

    await cdp.evaluate(`(() => {
      const api = window.__boardsApi;
      const frame = api.getSceneElements().find((el) => el.customData?.class && el.customData?.frame && !el.isDeleted);
      api.scrollToContent(frame, { fitToContent: true, animate: false });
      return true;
    })()`);
    await sleep(250);
    const tablePoint = await cdp.evaluate(`(() => {
      const api = window.__boardsApi;
      const s = api.getAppState();
      const zoom = s.zoom?.value || 1;
      const host = document.querySelector(".canvas").getBoundingClientRect();
      const frame = api.getSceneElements().find((el) => el.customData?.class && el.customData?.frame && !el.isDeleted);
      return {
        x: host.left + (frame.x + frame.width / 2 + (s.scrollX || 0)) * zoom,
        y: host.top + (frame.y + frame.height / 2 + (s.scrollY || 0)) * zoom,
      };
    })()`);
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: tablePoint.x,
      y: tablePoint.y,
      button: "none",
      buttons: 0,
    });
    await cdp.waitFor(`document.querySelector(".table-hover-arrows")?.classList.contains("visible")`, {
      label: "ER hover arrows appear",
    });
    const hoverButtons = await cdp.evaluate(`(() => {
      const out = {};
      for (const b of document.querySelectorAll(".table-hover-arrow")) {
        const r = b.getBoundingClientRect();
        out[b.dataset.direction] = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
      return out;
    })()`);
    check("ER class hover shows four directions", Object.keys(hoverButtons).length === 4, JSON.stringify(Object.keys(hoverButtons)));

    await cdp.evaluate(`document.querySelector('.table-hover-arrow[data-direction="right"]').click()`);
    await cdp.waitFor(`(() => {
      const api = window.__boardsApi;
      const els = api.getSceneElements();
      const frames = new Set(els.filter((el) => el.customData?.class && el.customData?.frame).map((el) => el.customData.grid));
      return frames.size === 2 && els.some((el) => el.type === "arrow" && el.customData?.relation);
    })()`, { label: "ER clone and relation created" });
    await sleep(500);
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
        sourceTitle: fromFrame?.customData.classData?.title,
        cloneTitle: toFrame?.customData.classData?.title,
        cloneFields: toFrame?.customData.classData?.fields?.length,
        cloneMethods: toFrame?.customData.classData?.methods?.length,
        sourceFrame: fromFrame && { x: fromFrame.x, y: fromFrame.y, w: fromFrame.width, h: fromFrame.height },
        cloneFrame: toFrame && { x: toFrame.x, y: toFrame.y, w: toFrame.width, h: toFrame.height },
        heads: [arrow.startArrowhead, arrow.endArrowhead],
        start: arrow.startBinding?.elementId,
        end: arrow.endBinding?.elementId,
        sourceBound: (fromFrame?.boundElements || []).some((b) => b.id === arrow.id),
        cloneBound: (toFrame?.boundElements || []).some((b) => b.id === arrow.id),
      };
    })()`);
    check(
      "ER clone keeps the class name, fields and methods",
      relation.cloneTitle === relation.sourceTitle &&
        relation.cloneFields === 3 &&
        relation.cloneMethods === 1,
      JSON.stringify(relation),
    );
    check(
      "ER clone is placed to the right",
      relation.cloneFrame.x >= relation.sourceFrame.x + relation.sourceFrame.w + 139,
      JSON.stringify(relation.cloneFrame),
    );
    check(
      "ER relation arrow binds both class frames",
      relation.start === `${relation.from}-frame` &&
        relation.end === `${relation.to}-frame` &&
        relation.sourceBound &&
        relation.cloneBound,
      JSON.stringify(relation),
    );
    check(
      "new ER relation defaults to 1:1",
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
      return {
        x: host.left + (arrow.x + arrow.width / 2 + (s.scrollX || 0)) * zoom,
        y: host.top + (arrow.y + arrow.height / 2 + (s.scrollY || 0)) * zoom,
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
      const a = api.getSceneElements().find((el) => el.type === "arrow" && el.customData?.relation);
      const frames = new Set(api.getSceneElements().filter((el) => el.customData?.class && el.customData?.frame).map((el) => el.customData.grid));
      return { frames: frames.size, heads: [a?.startArrowhead, a?.endArrowhead], bound: (a?.startBinding?.elementId || "").endsWith("-frame") };
    })()`);
    check(
      "ER relation and cardinality persist after reload",
      persisted.frames === 2 &&
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
