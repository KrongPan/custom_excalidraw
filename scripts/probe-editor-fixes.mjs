#!/usr/bin/env node
/**
 * Probe for the editor fixes (audit D1, D6, U5, B3, B4, B6).
 *
 * Starts the board server on a free port with a throwaway DATA_DIR and drives a
 * headless Chrome over CDP. Screenshots land in /tmp/fix-editor.
 *
 * Usage: node scripts/probe-editor-fixes.mjs
 * Exits non-zero when any check fails.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "../app/node_modules/ws/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = "/tmp/fix-editor";
const CHROME =
  process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BOARD = "probe-editor-fixes";
const results = [];

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

  async waitFor(expression, { timeout = 15000, interval = 120, label = expression } = {}) {
    const deadline = Date.now() + timeout;
    let lastError = "";
    while (Date.now() < deadline) {
      try {
        if (await this.evaluate(expression, { awaitPromise: true })) return true;
      } catch (error) {
        lastError = error.message;
      }
      await sleep(interval);
    }
    throw new Error(`timeout waiting for ${label}${lastError ? ` (last: ${lastError})` : ""}`);
  }

  async waitEvent(method, predicate = () => true, { timeout = 15000, from = 0 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const hit = this.events.slice(from).find((event) => event.method === method && predicate(event));
      if (hit) return hit;
      await sleep(60);
    }
    return null;
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
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile,
    });
  }
}

const rectangle = (id, x, y) => ({
  id,
  type: "rectangle",
  x,
  y,
  width: 140,
  height: 90,
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
  roundness: { type: 3 },
  seed: 12345,
  version: 1,
  versionNonce: 1,
  isDeleted: false,
  boundElements: [],
  updated: 1,
  link: null,
  locked: false,
});

async function waitForServer(base, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/boards`);
      if (response.ok) return;
    } catch {
      /* server still booting */
    }
    await sleep(100);
  }
  throw new Error("board server did not start");
}

(async () => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "probe-editor-data-"));
  const galleryDir = await mkdtemp(path.join(os.tmpdir(), "probe-editor-gallery-"));
  await writeFile(path.join(galleryDir, "index.html"), "<!doctype html><title>probe</title>\n");
  await mkdir(SHOTS, { recursive: true });

  const server = spawn(process.execPath, [path.join(ROOT, "app", "server.mjs")], {
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      GALLERY_DIR: galleryDir,
      APP_DIR: path.join(ROOT, "app", "dist"),
      GALLERY_BUILD: "",
    },
    stdio: "ignore",
  });

  const profile = await mkdtemp(path.join(os.tmpdir(), "probe-editor-chrome-"));
  const chromePort = await freePort();
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${chromePort}`,
      `--user-data-dir=${profile}`,
      "--window-size=1440,900",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  try {
    await waitForServer(base);

    const created = await fetch(`${base}/api/boards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: BOARD }),
    });
    const board = await created.json();
    const scene = {
      type: "excalidraw",
      version: 2,
      source: "probe",
      elements: [rectangle("probe-rect", 80, 80)],
      appState: { viewBackgroundColor: "#ffffff", theme: "light" },
      files: {},
    };
    const put = await fetch(`${base}/api/boards/${BOARD}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(scene),
    });
    if (!put.ok) throw new Error(`cannot seed board: ${put.status} ${await put.text()}`);

    let targets;
    for (let i = 0; i < 100; i += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${chromePort}/json/list`);
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
    const cdp = new CDP(ws);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");

    /* B4: wrap WebSocket so the first constructor call throws, the way a bad
       URL or a blocked workspace would: the retry has to come from the catch,
       not from onclose (which never runs when the constructor itself fails).
       `?nows=1` keeps every constructor failing, which is how the save check
       below forces the HTTP fallback instead of the socket. */
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `
        window.__wsAttempts = 0;
        const RealWebSocket = window.WebSocket;
        const noSocket = location.search.includes("nows=1");
        window.WebSocket = function (...args) {
          window.__wsAttempts += 1;
          if (noSocket || window.__wsAttempts === 1) throw new Error("probe: websocket disabled");
          return new RealWebSocket(...args);
        };
        window.WebSocket.prototype = RealWebSocket.prototype;
      `,
    });

    const editorReady = `!!window.__boardsApi && !!document.querySelector(".App-toolbar") && !document.body.textContent.includes("กำลังโหลดกระดาน")`;

    await cdp.viewport(1440, 900);
    await cdp.navigate(`${base}/b/${BOARD}`);
    await cdp.waitFor(editorReady, { label: "editor ready" });
    await cdp.waitFor(`document.documentElement.lang.toLowerCase().startsWith("th")`, {
      label: "Thai locale active",
      timeout: 8000,
    });

    /* ------------------------------------------------------------------ D1 */
    const lang = await cdp.evaluate(`document.documentElement.lang`);
    const english = await cdp.evaluate(`(() => {
      const text = document.querySelector(".excalidraw")?.innerText || "";
      return { text: text.slice(0, 4000), library: /\\bLibrary\\b/.test(text), shapes: /\\bShapes\\b/.test(text), thai: /คลัง|รูปร่าง|เมนู/.test(text) };
    })()`);
    check("D1 editor mounts with the Thai locale", lang === "th-TH", `html lang=${lang}`);
    check(
      "D1 no English Library/Shapes in the editor",
      !english.library && !english.shapes,
      JSON.stringify({ library: english.library, shapes: english.shapes, thai: english.thai }),
    );
    await cdp.screenshot(path.join(SHOTS, "editor-thai.png"));

    /* ------------------------------------------------------------------ D6 */
    await cdp.evaluate(`document.querySelector(".theme-toggle").click()`);
    await cdp.waitFor(`document.documentElement.dataset.theme === "dark"`, { label: "dark theme" });
    const darkMeta = await cdp.evaluate(
      `document.querySelector('meta[name="theme-color"]').getAttribute("content")`,
    );
    await cdp.evaluate(`document.querySelector(".theme-toggle").click()`);
    await cdp.waitFor(`document.documentElement.dataset.theme === "light"`, { label: "light theme" });
    const lightMeta = await cdp.evaluate(
      `document.querySelector('meta[name="theme-color"]').getAttribute("content")`,
    );
    check(
      "D6 theme-color follows the active theme",
      darkMeta === "#0f0f16" && lightMeta === "#f4f6ff",
      `dark=${darkMeta} light=${lightMeta}`,
    );

    /* ------------------------------------------------------------------ B4 */
    await cdp.waitFor(`window.__wsAttempts >= 2`, { label: "WebSocket retry", timeout: 5000 });
    const attempts = await cdp.evaluate(`window.__wsAttempts`);
    check("B4 a failed WebSocket constructor retries", attempts >= 2, `attempts=${attempts}`);

    /* ------------------------------------------------------------------ U5 */
    await cdp.viewport(1400, 900);
    await sleep(600);
    const desktopRow = await cdp.evaluate(`(() => {
      const rows = [...document.querySelectorAll(".App-toolbar")].filter((el) => el.getBoundingClientRect().width > 0);
      return rows.map((el) => { const r = el.getBoundingClientRect(); return { right: Math.round(r.right), cls: el.className }; });
    })()`);
    await cdp.viewport(393, 852, true);
    await sleep(1200);
    const phone = await cdp.evaluate(`(() => {
      const rows = [...document.querySelectorAll(".App-toolbar")].filter((el) => el.getBoundingClientRect().width > 0);
      return {
        vw: innerWidth,
        mobile: rows.some((el) => el.classList.contains("App-toolbar--mobile")),
        rows: rows.map((el) => { const r = el.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), cls: el.className }; }),
        maxRight: rows.length ? Math.max(...rows.map((el) => el.getBoundingClientRect().right)) : -1,
      };
    })()`);
    check(
      "U5 toolbar re-lays and fits after 1400 -> 393",
      phone.mobile && phone.maxRight > 0 && phone.maxRight <= 393.5,
      `desktop=${JSON.stringify(desktopRow)} phone=${JSON.stringify(phone)}`,
    );
    await cdp.screenshot(path.join(SHOTS, "editor-phone.png"));

    /* ------------------------------------------------------------------ B3 */
    // `?nows=1` keeps the WebSocket constructor failing (setBlockedURLs cannot
    // stop a WS handshake), so every save has to take the HTTP path; the PUT is
    // then paused in Fetch, which is exactly "a request that never answers"
    await cdp.navigate(`${base}/b/${BOARD}?nows=1`);
    await cdp.waitFor(editorReady, { label: "editor ready (offline socket)" });
    await sleep(1500);
    await cdp.send("Fetch.enable", {
      patterns: [{ urlPattern: "*/api/boards/*", requestStage: "Request" }],
    });
    const mark = cdp.events.length;
    // a theme flip is a queued save on its own, so it reaches the HTTP fallback
    // without relying on a synthetic scene edit landing in the armed window
    await cdp.evaluate(`document.querySelector(".theme-toggle").click()`);
    const paused = await cdp.waitEvent(
      "Fetch.requestPaused",
      (event) => event.params?.request?.method === "PUT",
      { timeout: 8000, from: mark },
    );
    check("B3 a save request was sent and hangs", Boolean(paused), paused ? paused.params.request.url : "no PUT seen");
    const startedAt = Date.now();
    let pill = null;
    let elapsed = 0;
    while (Date.now() - startedAt < 20000) {
      pill = await cdp.evaluate(`(() => { const p = document.querySelector(".save-pill"); return p ? { cls: p.className, text: p.textContent } : null; })()`);
      if (pill && pill.cls.includes("error")) {
        elapsed = Date.now() - startedAt;
        break;
      }
      await sleep(150);
    }
    check(
      "B3 a hung save flips the pill to the error state within 20s",
      Boolean(pill && pill.cls.includes("error")),
      `elapsed=${elapsed}ms pill=${JSON.stringify(pill)}`,
    );
    await cdp.screenshot(path.join(SHOTS, "save-timeout.png"));

    await cdp.send("Fetch.disable");
    await cdp.evaluate(`document.querySelector(".save-pill").click()`);
    let saved = null;
    const retryAt = Date.now();
    while (Date.now() - retryAt < 8000) {
      saved = await cdp.evaluate(`(() => { const p = document.querySelector(".save-pill"); return p ? { cls: p.className, text: p.textContent } : null; })()`);
      if (saved && saved.cls.includes("saved")) break;
      await sleep(150);
    }
    check("B3 the existing retry saves once the request goes through", Boolean(saved && saved.cls.includes("saved")), JSON.stringify(saved));

    /* ------------------------------------------------------------------ B6 */
    // the boundary cannot be thrown from the outside; prove its fallback copy
    // ships with the editor chunk instead of pretending a runtime throw ran
    const boundary = await cdp.evaluate(
      `(() => {
        const src = [...document.querySelectorAll("script[type=module]")].map((s) => s.src)[0] || "";
        return fetch(src)
          .then((response) => response.text())
          .then((text) => ({ src, hit: text.includes("เปิดกระดานนี้ไม่ได้") }));
      })()`,
      { awaitPromise: true },
    );
    check("B6 editor bundle carries the error-boundary fallback", Boolean(boundary?.hit), `${boundary?.src || "no entry chunk"}`);

    const boardShot = path.join(SHOTS, "editor-final.png");
    await cdp.screenshot(boardShot);

    /* --------------------------------------------------------------- report */
    const failed = results.filter((result) => !result.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed; screenshots in ${SHOTS}`);
    if (failed.length) process.exitCode = 1;
  } finally {
    try {
      chrome.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    try {
      server.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    await rm(profile, { recursive: true, force: true }).catch(() => {});
    await fetch(`${base}/api/boards/${BOARD}`, { method: "DELETE" }).catch(() => {});
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
    await rm(galleryDir, { recursive: true, force: true }).catch(() => {});
  }
})();
