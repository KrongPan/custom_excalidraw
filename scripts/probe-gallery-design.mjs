#!/usr/bin/env node
/**
 * scripts/probe-gallery-design.mjs — assert the catalogue's phone/desktop
 * design contract in a real headless Chrome.
 *
 * The audit that prompted the fix measured a 393px page in the browser, so the
 * only honest regression test is also a browser: the catalogue is built from a
 * throwaway scene fixture into a throwaway site directory, served by a stub
 * (no app/, no real gallery data), and measured over CDP.
 *
 *   node scripts/probe-gallery-design.mjs            # build + render + assert
 *   node scripts/probe-gallery-design.mjs --keep     # keep the temp world
 *
 * Checks, at 393x852 and 1400x900, light and dark:
 *   - no horizontal overflow (scrollWidth === viewport width)
 *   - the sticky phone bar is <= 300px tall and never covers a card
 *   - the group chip bar scrolls away while the title/actions/search bar stays
 *   - view switch + theme + "+ กระดานใหม่" share one row; search is full width
 *   - white CTA text is >= 4.5:1 against every stop of the button gradient
 *   - every small control grows a >= 40px hit area (44px card actions on phones)
 *   - no visible text under 12px on a phone (.meta is 13px)
 *   - thumbnails: first 3 eager/high priority, all lazy below, all sized
 *   - card metadata is Thai and the theme-color meta follows the theme
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const BUILD = path.join(ROOT, "gallery", "build.mjs");
const CHROME =
  process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const KEEP = process.argv.includes("--keep");
const TMP_ROOT = path.join(os.tmpdir(), `gallery-design-${process.pid}`);
const SHOTS = "/tmp/fix-design";

const GROUPS = [
  { id: "grp_aaaaaaaa", name: "งาน", color: "violet" },
  { id: "grp_bbbbbbbb", name: "ส่วนตัว", color: "blue" },
  { id: "grp_cccccccc", name: "คลัง", color: "teal" },
];

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

const BOARDS = [
  { id: "board-roadmap", title: "แผนงานไตรมาสนี้", group: 0, elements: [rect("r1", 0, 0, 1200, 620)] },
  { id: "board-dashboard", title: "Dashboard", group: 0, elements: [rect("r1", 0, 0, 980, 540)] },
  { id: "board-notes", title: "Notes", group: 1, elements: [rect("r1", 0, 0, 420, 300)] },
  { id: "board-tower", title: "Tower", group: 1, elements: [rect("r1", 0, 0, 360, 880)] },
  { id: "board-archive", title: "คลังไอเดีย", group: 2, elements: [rect("r1", 0, 0, 700, 420)] },
  { id: "board-sketch", title: "Sketch", group: 2, elements: [rect("r1", 0, 0, 520, 340)] },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    listeners.map((listener) => new Promise((resolve) => listener.close(resolve))),
  );
  return ports;
}

async function run(command, args, { env = process.env, timeout = 180000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
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
// Throwaway fixture + catalogue build.
// ---------------------------------------------------------------------------

async function seed(dataDir) {
  await mkdir(dataDir, { recursive: true });
  const now = Date.now();
  await writeFile(
    path.join(dataDir, ".groups.json"),
    JSON.stringify({
      version: 1,
      groups: GROUPS.map((group, index) => ({
        ...group,
        createdAt: new Date(now - (index + 1) * 86400000).toISOString(),
        updatedAt: new Date(now - (index + 1) * 86400000).toISOString(),
      })),
    }),
  );
  for (const [index, board] of BOARDS.entries()) {
    const dir = path.join(dataDir, board.id);
    await mkdir(dir, { recursive: true });
    const scene = {
      type: "excalidraw",
      version: 2,
      source: "scripts/probe-gallery-design.mjs",
      elements: board.elements,
      appState: { viewBackgroundColor: "#ffffff" },
      files: {},
    };
    const scenePath = path.join(dir, "scene.excalidraw");
    await writeFile(scenePath, JSON.stringify(scene));
    await writeFile(
      path.join(dir, "meta.json"),
      JSON.stringify({
        title: board.title,
        subtitle: "",
        tags: ["probe"],
        groupIds: [GROUPS[board.group].id],
        groupId: GROUPS[board.group].id,
      }),
    );
    // distinct days so the Thai date is visible in the meta line
    const stamp = new Date(now - index * 3 * 86400000);
    await utimes(scenePath, stamp, stamp).catch(() => {});
  }
}

async function buildSite(dataDir, siteDir) {
  await mkdir(siteDir, { recursive: true });
  const result = await run(process.execPath, [BUILD], {
    env: { ...process.env, SCENES_DIR: dataDir, SITE_DIR: siteDir },
  });
  if (result.code !== 0 || !existsSync(path.join(siteDir, "index.html"))) {
    throw new Error(`catalogue build failed (${result.code}): ${result.err || result.out}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Stub server: static catalogue + the two API answers the page asks for.
// ---------------------------------------------------------------------------

function serve(siteDir, dataDir, port) {
  const manifest = JSON.parse(readFileSync(path.join(siteDir, "manifest.json"), "utf8"));
  const groups = JSON.parse(readFileSync(path.join(dataDir, ".groups.json"), "utf8")).groups;
  const counts = new Map();
  for (const board of manifest.boards) {
    for (const id of board.groupIds || []) counts.set(id, (counts.get(id) || 0) + 1);
  }
  const types = {
    ".html": "text/html; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".excalidraw": "application/json; charset=utf-8",
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const pathname = decodeURIComponent(url.pathname);
    if (pathname === "/api/boards") {
      res.writeHead(200, { "content-type": types[".json"] });
      res.end(JSON.stringify({ boards: manifest.boards }));
      return;
    }
    if (pathname === "/api/groups") {
      res.writeHead(200, { "content-type": types[".json"] });
      res.end(
        JSON.stringify({
          groups: groups.map((group) => ({
            id: group.id,
            name: group.name,
            color: group.color,
            count: counts.get(group.id) || 0,
          })),
        }),
      );
      return;
    }
    let file = null;
    if (pathname === "/" || pathname === "/index.html") {
      file = path.join(siteDir, "index.html");
    } else if (pathname === "/manifest.json") {
      file = path.join(siteDir, "manifest.json");
    } else if (pathname.startsWith("/gallery/")) {
      file = path.join(siteDir, pathname.slice("/gallery/".length));
    }
    if (!file || !file.startsWith(siteDir) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": types[path.extname(file)] || "application/octet-stream",
      "cache-control": "no-cache",
    });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

// ---------------------------------------------------------------------------
// Minimal CDP driver (Node's global WebSocket, no dependencies).
// ---------------------------------------------------------------------------

async function launchChrome(port, profileDir) {
  const child = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--hide-scrollbars",
      "--disable-extensions",
      "--disable-dev-shm-usage",
      "--window-size=1400,900",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let version = null;
  for (let i = 0; i < 120; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      version = await response.json();
      break;
    } catch {
      await sleep(100);
    }
  }
  if (!version) throw new Error("Chrome did not expose a debugging port");
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    }
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const messageId = ++id;
      pending.set(messageId, { resolve, reject });
      ws.send(
        JSON.stringify({ id: messageId, method, params, ...(sessionId ? { sessionId } : {}) }),
      );
    });
  return {
    send,
    close: () => {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    },
  };
}

async function newPage(cdp, url) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params) => cdp.send(method, params, sessionId);
  await send("Page.enable");
  await send("Runtime.enable");
  const page = {
    async goto(address) {
      await send("Page.navigate", { url: address });
      for (let i = 0; i < 100; i += 1) {
        const ready = await page
          .eval('document.readyState === "complete" && document.querySelectorAll(".card").length > 0')
          .catch(() => false);
        if (ready) break;
        await sleep(100);
      }
      await sleep(250);
    },
    async eval(expression) {
      const result = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) {
        throw new Error(
          result.exceptionDetails.text +
            " " +
            (result.exceptionDetails.exception?.description || ""),
        );
      }
      return result.result.value;
    },
    async viewport(width, height, mobile) {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: mobile ? 2 : 1,
        mobile,
      });
    },
    async emulateMedia(scheme) {
      await send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: scheme }],
      });
    },
    async scrollTo(y) {
      await page.eval(`window.scrollTo(0, ${Math.max(0, Math.round(y))})`);
      await sleep(120);
    },
    async shot(name) {
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      await mkdir(SHOTS, { recursive: true });
      const file = path.join(SHOTS, `${name}.png`);
      await writeFile(file, Buffer.from(data, "base64"));
      return file;
    },
    async close() {
      await cdp.send("Target.closeTarget", { targetId });
    },
  };
  return page;
}

// ---------------------------------------------------------------------------
// Page-side measurements. Each returns plain JSON so the assertion code stays
// in Node (where a failure can print a useful message).
// ---------------------------------------------------------------------------

const MEASURE = `(() => {
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height, bottom: r.bottom, right: r.right };
  };
  const top = document.querySelector(".top");
  const groupbar = document.querySelector("#groupbar");
  const header = document.querySelector("header");
  const card = document.querySelector(".card");
  const search = document.querySelector("#q");
  const view = document.querySelector("#view-switch");
  const theme = document.querySelector("#theme-toggle");
  const app = document.querySelector(".app-link");
  return {
    width: innerWidth,
    height: innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollX: scrollX,
    topBar: box(top),
    topPosition: getComputedStyle(top).position,
    groupbar: groupbar && !groupbar.hidden ? box(groupbar) : null,
    groupbarPosition: groupbar ? getComputedStyle(groupbar).position : null,
    headerDisplay: getComputedStyle(header).display,
    headerBox: box(header),
    card: card ? box(card) : null,
    search: search ? box(search) : null,
    view: view ? box(view) : null,
    theme: theme ? box(theme) : null,
    app: app ? box(app) : null,
    h1: document.querySelector("h1") ? box(document.querySelector("h1")) : null,
    themeColor: document.querySelector('meta[name="theme-color"]').getAttribute("content"),
    dataTheme: document.documentElement.getAttribute("data-theme"),
    bodyBg: getComputedStyle(document.body).backgroundColor,
  };
})()`;

const HIT = `(() => {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
  };
  const selectors = [
    ["theme", ".themebtn"],
    ["bar-toggle", ".bar-toggle"],
    ["view-btn", ".view-btn"],
    ["chip", ".chip"],
    ["group-new", "#group-new"],
    ["sect-toggle", ".sect-toggle"],
    ["sect-btn", ".sect-btn"],
    ["card-group", "button.card-group"],
    ["primary", ".primary"],
    ["iconbtn", ".iconbtn"],
    ["app-link", ".app-link"],
  ];
  const rows = [];
  for (const [kind, selector] of selectors) {
    for (const el of [...document.querySelectorAll(selector)].filter(visible)) {
      const before = getComputedStyle(el, "::before");
      const r = el.getBoundingClientRect();
      rows.push({
        kind,
        selector,
        w: Math.round(r.width),
        h: Math.round(r.height),
        hitW: Math.round(parseFloat(before.width) || 0),
        hitH: Math.round(parseFloat(before.height) || 0),
        content: before.content,
      });
    }
  }
  return rows;
})()`;

const CONTRAST = `(() => {
  const lum = (rgb) => {
    const c = rgb.map((v) => {
      const x = v / 255;
      return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a, b) => {
    const [hi, lo] = lum(a) >= lum(b) ? [lum(a), lum(b)] : [lum(b), lum(a)];
    return (hi + 0.05) / (lo + 0.05);
  };
  const parse = (text) => {
    const match = text.match(/rgba?\\(([^)]+)\\)/);
    if (!match) return null;
    const parts = match[1].split(",").map((v) => parseFloat(v));
    return parts.slice(0, 3);
  };
  const out = [];
  for (const selector of [".primary", ".app-link"]) {
    for (const el of document.querySelectorAll(selector)) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const style = getComputedStyle(el);
      const fg = parse(style.color);
      const stops = [...style.backgroundImage.matchAll(/rgba?\\([^)]+\\)/g)]
        .map((m) => parse(m[0]))
        .filter(Boolean);
      if (!fg || stops.length === 0) {
        out.push({ selector, fg: style.color, stops: [], min: 0, missing: true });
        continue;
      }
      const min = Math.min(...stops.map((stop) => ratio(fg, stop)));
      out.push({ selector, fg: style.color, stops: style.backgroundImage, min });
    }
  }
  return out;
})()`;

const FONTS = `(() => {
  const els = [...document.querySelectorAll("body *")];
  const small = [];
  const sizes = [];
  for (const el of els) {
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!own) continue;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (rect.width === 0 || rect.height === 0 || style.visibility === "hidden" || style.display === "none") continue;
    if (el.closest("[hidden]")) continue;
    const size = parseFloat(style.fontSize);
    sizes.push(size);
    if (size < 12) {
      small.push({
        tag: el.tagName.toLowerCase(),
        cls: el.className || "",
        text: el.textContent.trim().slice(0, 40),
        size,
      });
    }
  }
  return { min: sizes.length ? Math.min(...sizes) : null, small };
})()`;

const THUMBS = `(() => {
  const imgs = [...document.querySelectorAll(".shot img")];
  return imgs.map((img, index) => ({
    index,
    loading: img.getAttribute("loading"),
    fetchpriority: img.getAttribute("fetchpriority"),
    width: img.getAttribute("width"),
    height: img.getAttribute("height"),
    naturalWidth: img.naturalWidth,
  }));
})()`;

const META = `(() => {
  const el = document.querySelector(".meta");
  const imgs = [...document.querySelectorAll(".card")].slice(0, 6).map((card) => ({
    text: card.querySelector(".meta") ? card.querySelector(".meta").textContent : "",
    title: card.querySelector(".meta") ? card.querySelector(".meta").title : "",
  }));
  return { first: el ? el.textContent : "", cards: imgs };
})()`;

const ROW = `(() => {
  const b = (selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
  };
  return {
    search: b("#q"),
    view: b("#view-switch"),
    theme: b("#theme-toggle"),
    app: b(".app-link"),
    top: b(".top"),
    groupbar: b("#groupbar"),
    card: b(".card"),
    h1: b("header h1"),
    groupChips: [...document.querySelectorAll("#group-chips .chip")].map((el) => el.textContent.trim()),
  };
})()`;

// ---------------------------------------------------------------------------
// Assertions.
// ---------------------------------------------------------------------------

let passed = 0;
const failures = [];
function check(ok, label, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ok  ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures.push({ label, detail });
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function approx(a, b, tolerance) {
  return Math.abs(a - b) <= tolerance;
}

async function measureSticky(page, width) {
  const base = await page.eval(MEASURE);
  check(
    base.scrollWidth <= width,
    `no horizontal overflow at ${width}`,
    `scrollWidth ${base.scrollWidth}`,
  );
  if (width <= 640) {
    check(
      base.headerDisplay === "contents",
      "phone: the header box itself is out of the sticky flow",
      `header display ${base.headerDisplay}`,
    );
    check(base.topBar.height <= 300, "sticky bar height <= 300", `${Math.round(base.topBar.height)}px`);
    check(
      base.topPosition === "sticky",
      "phone: title/actions/search bar is sticky",
      base.topPosition,
    );
    check(
      base.groupbar === null || base.groupbarPosition !== "sticky",
      "phone: group chip bar is not pinned",
      base.groupbar ? base.groupbarPosition : "absent",
    );
  } else {
    check(
      base.headerBox.height > 0 && base.headerBox.height <= 300,
      "desktop header <= 300",
      `${Math.round(base.headerBox.height)}px`,
    );
  }

  if (width > 640) return;
  // Scroll far enough that the bar is genuinely stuck: content at y=300 must
  // still belong to a card and the chip bar must have gone underneath.
  await page.scrollTo(600);
  const stuck = await page.eval(MEASURE);
  check(stuck.topBar.top <= 12, "sticky bar stays at the top", `${Math.round(stuck.topBar.top)}px`);
  if (stuck.groupbar) {
    check(
      stuck.groupbar.bottom < stuck.topBar.top,
      "group chip bar scrolled under the page",
      `chips bottom ${Math.round(stuck.groupbar.bottom)} < bar top ${Math.round(stuck.topBar.top)}`,
    );
  }
  const hit = await page.eval(
    `(() => {
      const card = [...document.querySelectorAll(".card")]
        .map((el) => el.getBoundingClientRect())
        .find((r) => r.top < 300 && r.bottom > 320);
      if (!card) return { found: false };
      const el = document.elementFromPoint(card.left + card.width / 2, 300);
      return {
        found: true,
        tag: el ? el.tagName : "none",
        inHeader: !!(el && el.closest("header")),
        inCard: !!(el && el.closest(".card")),
      };
    })()`,
  );
  check(
    hit.found && hit.inCard && !hit.inHeader,
    "content at y=300 is a reachable card, not covered by the bar",
    hit.found ? `hit <${hit.tag}>${hit.inHeader ? " (header)" : ""}` : "no card at 300",
  );
  await page.scrollTo(0);
}

async function measureRows(page, width) {
  const row = await page.eval(ROW);
  if (width <= 520) {
    const sameRow =
      row.view && row.theme && row.app &&
      approx(row.view.top, row.theme.top, 8) &&
      approx(row.view.top, row.app.top, 8);
    check(
      !!sameRow,
      "phone: view switch + theme + new board share one row",
      row.view ? `view ${Math.round(row.view.top)}, theme ${Math.round(row.theme.top)}, app ${Math.round(row.app.top)}` : "missing",
    );
    const contentWidth = row.top.width - 22;
    check(
      !!row.search && row.search.top >= row.view.bottom - 1 && row.search.width >= contentWidth - 2,
      "phone: search is full width on its own row",
      row.search ? `w ${Math.round(row.search.width)} vs ${Math.round(contentWidth)}` : "missing",
    );
    check(
      !!row.theme && row.h1 && row.theme.top >= row.h1.bottom - 1,
      "phone: theme toggle left the title row",
      row.theme && row.h1 ? `theme ${Math.round(row.theme.top)} >= title ${Math.round(row.h1.bottom)}` : "missing",
    );
  } else {
    check(
      !!row.view && !!row.theme && !!row.app && approx(row.view.top, row.theme.top, 8),
      "desktop: controls still share the title row",
    );
  }
  check(
    row.groupChips.length > 0,
    "group chips render from the stub API",
    `${row.groupChips.length} chip(s)`,
  );
}

async function measureTargets(page, width) {
  const rows = await page.eval(HIT);
  const kinds = [...new Set(rows.map((row) => row.kind))];
  for (const kind of kinds) {
    const items = rows.filter((row) => row.kind === kind);
    const requireWidth = kind !== "view-btn";
    const minH = Math.min(...items.map((row) => row.hitH));
    const minW = Math.min(...items.map((row) => row.hitW));
    check(
      minH >= (width <= 640 && (kind === "primary" || kind === "iconbtn") ? 44 : 40),
      `${kind}: hit height ${kind === "primary" || kind === "iconbtn" ? "44 (phone)" : "40"}`,
      `${minH}px over ${items.length} control(s)`,
    );
    if (requireWidth) {
      check(minW >= 40, `${kind}: hit width 40`, `${minW}px`);
    }
    check(
      items.every((row) => row.content !== "none"),
      `${kind}: transparent hit layer exists`,
    );
  }

  // A point 3px above the painted box must still resolve to the control, so
  // the hit layer is real rather than a computed-style illusion.
  const hits = await page.eval(
    `(() => {
      const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const out = [];
      const all = [...document.querySelectorAll("#theme-toggle, .chip, .app-link, .primary")].filter(visible);
      for (const el of all) {
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top - 3;
        if (y < 0 || y > innerHeight - 1 || x < 0 || x > innerWidth - 1) continue;
        const hit = document.elementFromPoint(x, y);
        out.push({ cls: el.className, above: !!hit && (hit === el || el.contains(hit)), tag: hit ? hit.className || hit.tagName : "none" });
      }
      return out;
    })()`,
  );
  check(
    hits.length > 0 && hits.every((hit) => hit.above),
    "hit layer receives taps just outside the painted box",
    `${hits.filter((hit) => hit.above).length}/${hits.length}`,
  );
}

async function measureFonts(page) {
  const fonts = await page.eval(FONTS);
  check(fonts.small.length === 0, "phone: no visible text under 12px", `smallest ${fonts.min}px`);
  if (fonts.small.length) {
    for (const item of fonts.small.slice(0, 6)) {
      console.log(`       ${item.size}px <${item.tag}.${item.cls}> ${item.text}`);
    }
  }
  const meta = await page.eval(
    `(() => { const el = document.querySelector(".meta"); return el ? parseFloat(getComputedStyle(el).fontSize) : null; })()`,
  );
  check(meta >= 13, "phone: card meta is 13px", `${meta}px`);
}

async function measureContrast(page) {
  const rows = await page.eval(CONTRAST);
  check(rows.length > 0, "CTA buttons are on the page", `${rows.length} buttons`);
  for (const row of rows) {
    check(
      !row.missing && row.min >= 4.5,
      `${row.selector} white text >= 4.5:1 at every gradient stop`,
      row.missing ? "no gradient parsed" : `${row.min.toFixed(2)}:1`,
    );
  }
}

async function measureThumbs(page) {
  const thumbs = await page.eval(THUMBS);
  check(thumbs.length >= 4, "thumbnails render", `${thumbs.length} images`);
  const head = thumbs.slice(0, 3);
  const tail = thumbs.slice(3);
  check(
    head.every((img) => img.loading === "eager" && img.fetchpriority === "high"),
    "first 3 thumbs are eager/high priority",
    head.map((img) => img.loading).join(","),
  );
  check(
    tail.every((img) => img.loading === "lazy"),
    "the rest are lazy",
    tail.map((img) => img.loading).join(","),
  );
  check(
    thumbs.every((img) => Number(img.width) > 0 && Number(img.height) > 0),
    "every thumb declares width/height",
    thumbs.map((img) => `${img.width}x${img.height}`).join(" "),
  );
  check(
    thumbs.every((img) => img.naturalWidth > 0 && img.naturalWidth <= 1100),
    "thumbs actually load",
    `max natural ${Math.max(...thumbs.map((img) => img.naturalWidth))}px`,
  );
}

async function measureMeta(page) {
  const meta = await page.eval(META);
  check(
    /\d+ องค์ประกอบ · \d+ (B|KB|MB) · \d+ [ก-ฮ]\./.test(meta.first) &&
      !/elements|×/.test(meta.first),
    "card metadata is Thai and drops W×H",
    meta.first,
  );
  check(
    meta.cards.every((card) => /[ก-ฮ]\./.test(card.title)),
    "meta tooltip carries the Thai date",
    meta.cards[0] ? meta.cards[0].title : "",
  );
}

async function measureThemeColor(page, theme) {
  const state = await page.eval(MEASURE);
  const dark = theme === "dark";
  check(
    state.dataTheme === theme,
    `theme is ${theme}`,
    state.dataTheme,
  );
  check(
    state.themeColor.toLowerCase() === (dark ? "#0b0d16" : "#eef1f8"),
    `theme-color follows ${theme}`,
    state.themeColor,
  );
  if (dark) {
    check(state.bodyBg === "rgb(11, 13, 22)", "dark body is near-black", state.bodyBg);
  }
}

// ---------------------------------------------------------------------------

async function openThemed(page, base, theme) {
  await page.goto(base);
  await page.eval(`localStorage.setItem("boards-theme", ${JSON.stringify(theme)})`);
  // headless Chrome defaults to prefers-color-scheme: dark, so pin it to light
  // and let the stored theme decide what the page renders.
  await page.emulateMedia("light");
  await page.goto(base);
}

async function main() {
  await mkdir(SHOTS, { recursive: true });
  await rm(TMP_ROOT, { recursive: true, force: true });
  const dataDir = path.join(TMP_ROOT, "data");
  const siteDir = path.join(TMP_ROOT, "site");
  await seed(dataDir);
  console.log(`building catalogue from ${BOARDS.length} throwaway boards…`);
  await buildSite(dataDir, siteDir);

  const [httpPort, debugPort] = await freePorts(2);
  const server = await serve(siteDir, dataDir, httpPort);
  const cdp = await launchChrome(debugPort, path.join(TMP_ROOT, "chrome"));
  const base = `http://127.0.0.1:${httpPort}/`;
  const summary = {};

  try {
    // ---------------------------------------------------------- phone ------
    console.log("\n393x852, light");
    let page = await newPage(cdp, base);
    await page.viewport(393, 852, true);
    await openThemed(page, base, "light");
    await measureThemeColor(page, "light");
    await measureSticky(page, 393);
    await measureRows(page, 393);
    await measureTargets(page, 393);
    await measureFonts(page);
    await measureContrast(page);
    await measureThumbs(page);
    await measureMeta(page);
    const lightShot = await page.shot("gallery-393-light");
    await page.scrollTo(260);
    const scrolledShot = await page.shot("gallery-393-light-scrolled");
    await page.scrollTo(0);

    console.log("\n393x852, dark");
    await page.eval('document.querySelector("#theme-toggle").click()');
    await sleep(200);
    await measureThemeColor(page, "dark");
    await measureContrast(page);
    await measureSticky(page, 393);
    const darkShot = await page.shot("gallery-393-dark");
    // The pre-paint script must put the dark theme-color back on a reload.
    await page.goto(base);
    await measureThemeColor(page, "dark");
    summary.phone = { lightShot, scrolledShot, darkShot };
    await page.close();

    // -------------------------------------------------------- desktop ------
    console.log("\n1400x900, light");
    page = await newPage(cdp, base);
    await page.viewport(1400, 900, false);
    await openThemed(page, base, "light");
    await measureThemeColor(page, "light");
    await measureSticky(page, 1400);
    await measureRows(page, 1400);
    await measureContrast(page);
    const desktopLight = await page.shot("gallery-1400-light");

    console.log("\n1400x900, dark");
    await page.eval('document.querySelector("#theme-toggle").click()');
    await sleep(200);
    await measureThemeColor(page, "dark");
    await measureContrast(page);
    const desktopDark = await page.shot("gallery-1400-dark");
    summary.desktop = { desktopLight, desktopDark };
    await page.close();
  } finally {
    cdp.close();
    await new Promise((resolve) => server.close(resolve));
  }

  console.log(
    `\n${passed} check(s) passed, ${failures.length} failed · screenshots in ${SHOTS}`,
  );
  await writeFile(
    path.join(SHOTS, "probe.json"),
    JSON.stringify({ passed, failures, shots: summary }, null, 2),
  );
  if (!KEEP) await rm(TMP_ROOT, { recursive: true, force: true });
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
