#!/usr/bin/env node
/**
 * Catalog check for the multi-group (หมวดหมู่) UI and the dark/light theme.
 *
 * Builds a throwaway catalogue from three scenes, serves it from a stub API that
 * implements the documented multi-membership contract, and drives headless
 * Chrome over CDP to prove the behaviours the backend worker has to support:
 *
 *   - a board can be filed under several groups at once (groupIds: string[])
 *   - the grid repeats that board as a card in every group's section, and only
 *     in "ไม่มีหมวดหมู่" when it belongs to none
 *   - the per-card trigger (button.card-group) opens a multi-select popover;
 *     one tick sends one PATCH {groupIds} and re-renders, keeping the menu open
 *   - a 404 from that PATCH reverts the checkbox and says so
 *   - a chip filters to its own section; search works across duplicated cards
 *   - create / rename / delete a group, including boards in several groups
 *   - legacy servers (groupId only, or no inline membership at all), a missing
 *     /api/groups, the 393px layout, the theme toggle and its no-flash head script
 *
 * Usage: node scripts/test-catalog-groups.mjs
 * Needs: node 22+ (global WebSocket), a local Chrome. Exits non-zero on failure.
 * Screenshots land in /tmp/catalog-groups (override with OUT_DIR).
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = process.env.OUT_DIR || "/tmp/catalog-groups";

const results = [];
let failures = 0;

function check(name, ok, detail = "") {
  const pass = Boolean(ok);
  results.push({ name, ok: pass, detail: String(detail || "") });
  if (!pass) failures += 1;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  return pass;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ png io */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Minimal 8-bit RGB PNG writer: enough for a soft gradient preview. */
function encodePng(width, height, pixel) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      const at = y * stride + 1 + x * 3;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
    }
  }
  const chunks = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    chunks.push(length, body, crc);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  chunk("IHDR", ihdr);
  chunk("IDAT", zlib.deflateSync(raw));
  chunk("IEND", Buffer.alloc(0));
  return Buffer.concat(chunks);
}

/** Decode an 8-bit non-interlaced PNG (RGB or RGBA) so pixels can be measured. */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a png");
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + length);
    pos += 12 + length;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8) throw new Error(`unsupported bit depth ${data[8]}`);
      colorType = data[9];
      if (data[12] !== 0) throw new Error("interlaced png");
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`unsupported colour type ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      const v = line[x];
      let value;
      if (filter === 0) value = v;
      else if (filter === 1) value = v + a;
      else if (filter === 2) value = v + b;
      else if (filter === 3) value = v + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw new Error(`bad filter ${filter}`);
      cur[x] = value & 0xff;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return { width, height, channels, data: out };
}

/** Mean relative luminance of a pixel rectangle (sRGB, 0 = black, 1 = white). */
function meanLuminance(png, region) {
  const { width, channels, data } = png;
  const x0 = Math.max(0, Math.round(region.x));
  const y0 = Math.max(0, Math.round(region.y));
  const x1 = Math.min(png.width, Math.round(region.x + region.width));
  const y1 = Math.min(png.height, Math.round(region.y + region.height));
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const at = (y * width + x) * channels;
      const lin = (v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      sum += 0.2126 * lin(data[at]) + 0.7152 * lin(data[at + 1]) + 0.0722 * lin(data[at + 2]);
      n += 1;
    }
  }
  return n ? sum / n : 0;
}

/* --------------------------------------------------------------- fixtures */

const SEEDS = [
  { id: "alpha-board", title: "แผนลูกค้า Alpha", subtitle: "deck ลูกค้า" },
  { id: "beta-board", title: "สรุปงาน Beta", subtitle: "งานภายใน" },
  { id: "gamma-board", title: "ทดลอง Gamma", subtitle: "ยังไม่จัดหมวด" },
];

const G1 = "grp_aa11bb22";
const G2 = "grp_cc33dd44";

/* ------------------------------------------------------------ stub server */

function createStub(siteDir, slugs) {
  const state = {
    log: [],
    // how /api/boards carries membership:
    //   inline = groupIds + groupId (merged backend)
    //   legacy = groupId only (an older backend)
    //   none   = neither (the per-card meta fallback has to do the work)
    mode: "inline",
    // one-shot 404 on PATCH /api/boards/:id/meta, standing in for an unknown id
    rejectMetaOnce: false,
    groupsDisabled: false,
    groups: [
      { id: G1, name: "ลูกค้า", color: "violet", createdAt: "2026-11-01T09:00:00.000Z", updatedAt: "2026-11-01T09:00:00.000Z" },
      { id: G2, name: "งานภายใน", color: "teal", createdAt: "2026-11-02T09:00:00.000Z", updatedAt: "2026-11-02T09:00:00.000Z" },
    ],
    // alpha is deliberately in two groups, beta in one, gamma in none
    membership: new Map([
      [slugs[0], [G1, G2]],
      [slugs[1], [G1]],
      [slugs[2], []],
    ]),
    boards: new Map(
      slugs.map((slug, index) => [
        slug,
        {
          id: slug,
          title: SEEDS[index].title,
          subtitle: SEEDS[index].subtitle,
          updated: Date.UTC(2026, 10, 20 + index, 3, 0, 0),
          bytes: 18_000 + index * 4200,
          elements: 12 + index * 5,
        },
      ]),
    ),
    nextId: 0,
  };

  const idsOf = (slug) => (state.membership.get(slug) || []).slice();
  const countOf = (groupId) => {
    let n = 0;
    for (const ids of state.membership.values()) if (ids.includes(groupId)) n += 1;
    return n;
  };
  const groupJson = (group) => ({ ...group, count: countOf(group.id) });
  const membershipJson = (slug) => {
    const ids = idsOf(slug);
    return { groupId: ids[0] || null, groupIds: ids };
  };
  const nameTaken = (name, exceptId) =>
    state.groups.some(
      (group) => group.id !== exceptId && group.name.toLowerCase() === name.toLowerCase(),
    );

  const json = (res, status, body) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(text);
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const pathname = decodeURIComponent(url.pathname);
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      let parsed = null;
      if (body) {
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = null;
        }
      }
      state.log.push({ method: req.method, path: pathname, query: url.search, body: parsed });

      /* static build output */
      if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(readFileSync(path.join(siteDir, "index.html")));
        return;
      }
      if (req.method === "GET" && /^\/gallery\/logo-\d+\.png$/.test(pathname)) {
        // the brand marks the real catalogue copies into its site folder
        const file = path.join(siteDir, path.basename(pathname));
        if (!existsSync(file)) return json(res, 404, { error: "no logo" });
        res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
        res.end(readFileSync(file));
        return;
      }
      if (req.method === "GET" && pathname.startsWith("/gallery/thumbs/")) {
        const file = path.join(siteDir, "thumbs", path.basename(pathname));
        if (!existsSync(file)) return json(res, 404, { error: "no thumb" });
        res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
        res.end(readFileSync(file));
        return;
      }
      if (req.method === "GET" && pathname.startsWith("/scenes/")) {
        const file = path.join(siteDir, "scenes", path.basename(pathname));
        if (!existsSync(file)) return json(res, 404, { error: "no scene" });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(readFileSync(file));
        return;
      }
      if (req.method === "GET" && pathname === "/manifest.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(readFileSync(path.join(siteDir, "manifest.json")));
        return;
      }

      /* boards */
      if (req.method === "GET" && pathname === "/api/boards") {
        const boards = [...state.boards.values()].map((board) => {
          const out = {
            id: board.id,
            title: board.title,
            subtitle: board.subtitle,
            updated: board.updated,
            bytes: board.bytes,
            elements: board.elements,
          };
          if (state.mode === "inline") Object.assign(out, membershipJson(board.id));
          else if (state.mode === "legacy") out.groupId = idsOf(board.id)[0] || null;
          return out;
        });
        return json(res, 200, { boards });
      }
      const boardMeta = pathname.match(/^\/api\/boards\/([^/]+)\/meta$/);
      if (boardMeta) {
        const id = boardMeta[1];
        const board = state.boards.get(id);
        if (!board) return json(res, 404, { error: "unknown board" });
        if (req.method === "GET") {
          return json(res, 200, {
            id,
            title: board.title,
            subtitle: board.subtitle,
            ...membershipJson(id),
            updatedAt: new Date(board.updated).toISOString(),
          });
        }
        if (req.method === "PATCH") {
          if (!parsed || typeof parsed !== "object") return json(res, 400, { error: "bad body" });
          if (state.rejectMetaOnce) {
            state.rejectMetaOnce = false;
            return json(res, 404, { error: "unknown group" });
          }
          if (typeof parsed.title === "string") board.title = parsed.title.slice(0, 120);
          if (typeof parsed.subtitle === "string") board.subtitle = parsed.subtitle.slice(0, 120);
          if (Object.prototype.hasOwnProperty.call(parsed, "groupIds")) {
            if (!Array.isArray(parsed.groupIds)) return json(res, 400, { error: "groupIds must be an array" });
            const next = [];
            for (const groupId of parsed.groupIds) {
              if (typeof groupId !== "string" || !state.groups.some((group) => group.id === groupId)) {
                // matches the documented contract: an unknown id is a 404
                return json(res, 404, { error: "unknown group" });
              }
              if (!next.includes(groupId)) next.push(groupId);
            }
            state.membership.set(id, next);
          } else if (Object.prototype.hasOwnProperty.call(parsed, "groupId")) {
            const next = parsed.groupId;
            if (next === null || next === "") state.membership.set(id, []);
            else if (typeof next === "string" && state.groups.some((group) => group.id === next)) {
              state.membership.set(id, [next]);
            } else return json(res, 404, { error: "unknown group" });
          }
          board.updated = Date.now();
          return json(res, 200, {
            id,
            title: board.title,
            subtitle: board.subtitle,
            ...membershipJson(id),
          });
        }
        return json(res, 405, { error: "method" });
      }
      const boardOne = pathname.match(/^\/api\/boards\/([^/]+)$/);
      if (boardOne && req.method === "DELETE") {
        const id = boardOne[1];
        if (!state.boards.has(id)) return json(res, 404, { error: "unknown board" });
        state.boards.delete(id);
        state.membership.delete(id);
        return json(res, 200, { deleted: id });
      }

      /* groups */
      if (pathname === "/api/groups" && req.method === "GET") {
        if (state.groupsDisabled) return json(res, 404, { error: "no groups api" });
        return json(res, 200, { groups: state.groups.map(groupJson) });
      }
      if (pathname === "/api/groups" && req.method === "POST") {
        const name = parsed && typeof parsed.name === "string" ? parsed.name.trim() : "";
        const color = parsed && typeof parsed.color === "string" ? parsed.color : "violet";
        if (!name || name.length > 60) return json(res, 400, { error: "bad name" });
        if (nameTaken(name)) return json(res, 409, { error: "duplicate" });
        const group = {
          id: `grp_${(0x10000000 + (state.nextId += 1)).toString(16)}${G1.slice(4, 8)}`.slice(0, 12),
          name,
          color,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        state.groups.push(group);
        return json(res, 201, { group: groupJson(group) });
      }
      const groupOne = pathname.match(/^\/api\/groups\/([^/]+)$/);
      if (groupOne) {
        const id = groupOne[1];
        const group = state.groups.find((item) => item.id === id);
        if (!group) return json(res, 404, { error: "unknown group" });
        if (req.method === "PATCH") {
          const name = parsed && typeof parsed.name === "string" ? parsed.name.trim() : group.name;
          if (!name || name.length > 60) return json(res, 400, { error: "bad name" });
          if (nameTaken(name, id)) return json(res, 409, { error: "duplicate" });
          group.name = name;
          if (parsed && typeof parsed.color === "string") group.color = parsed.color;
          group.updatedAt = new Date().toISOString();
          return json(res, 200, { group: groupJson(group) });
        }
        if (req.method === "DELETE") {
          // a board in several groups only loses this one membership
          const moved = countOf(id);
          state.groups = state.groups.filter((item) => item.id !== id);
          for (const [boardId, ids] of [...state.membership.entries()]) {
            state.membership.set(boardId, ids.filter((groupId) => groupId !== id));
          }
          return json(res, 200, { deleted: id, moved });
        }
      }
      return json(res, 404, { error: `no route ${req.method} ${pathname}` });
    });
  });

  return { server, state, countOf };
}

/* --------------------------------------------------------------- cdp glue */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.consoleErrors = [];
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
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
    });
  }

  send(method, params = {}) {
    const id = (this.nextId += 1);
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
      const details = result.exceptionDetails;
      throw new Error(details.exception?.description || details.text || "evaluate failed");
    }
    return result.result?.value;
  }

  async waitFor(expression, { timeout = 15000, interval = 100, label = expression } = {}) {
    const deadline = Date.now() + timeout;
    let last = "";
    while (Date.now() < deadline) {
      try {
        if (await this.evaluate(expression)) return true;
      } catch (error) {
        last = error.message;
      }
      await sleep(interval);
    }
    throw new Error(`timeout waiting for ${label}${last ? ` (last error: ${last})` : ""}`);
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
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: Math.round(r.width), h: Math.round(r.height) };
    })()`);
    if (!box) throw new Error(`cannot click missing/invisible element ${selector}`);
    const hit = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      const r = el.getBoundingClientRect();
      const node = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!node) return { ok: false, why: "nothing at that point" };
      return {
        ok: node === el || el.contains(node),
        node: node.tagName.toLowerCase() + (node.id ? "#" + node.id : "") + (node.className ? "." + String(node.className).split(" ").join(".") : ""),
      };
    })()`);
    if (!hit.ok) throw new Error(`element ${selector} is covered by ${hit.node} at ${Math.round(box.x)},${Math.round(box.y)}`);
    await sleep(70);
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

  /* press and hold on one element — needed by the hold-to-delete button */
  async hold(selector, ms) {
    const box = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: Math.round(r.width), h: Math.round(r.height) };
    })()`);
    if (!box) throw new Error(`cannot hold on missing/invisible element ${selector}`);
    await sleep(70);
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y, button: "none", buttons: 0, clickCount: 0 });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", buttons: 1, clickCount: 1 });
    await sleep(ms);
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", buttons: 0, clickCount: 1 });
    return box;
  }

  async type(text) {
    await this.send("Input.insertText", { text });
  }

  async press(key, code, vk) {
    const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  async backspace(times) {
    for (let i = 0; i < times; i += 1) {
      await this.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Backspace",
        code: "Backspace",
        windowsVirtualKeyCode: 8,
        nativeVirtualKeyCode: 8,
      });
      await this.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Backspace",
        code: "Backspace",
        windowsVirtualKeyCode: 8,
        nativeVirtualKeyCode: 8,
      });
    }
  }

  async navigate(url) {
    await this.send("Page.navigate", { url });
    await this.waitFor("document.readyState === 'complete'", { label: `load ${url}` });
  }

  async reload() {
    await this.send("Page.reload", { ignoreCache: false });
    await sleep(60);
    await this.waitFor("document.readyState === 'complete'", { label: "reload" });
  }

  /* hide a lingering toast so the captured picture shows the steady state */
  async quiet() {
    await this.evaluate(`(() => {
      const toast = document.getElementById("toast");
      if (toast) { toast.hidden = true; toast.classList.remove("on"); }
    })()`);
    await sleep(90);
  }

  async screenshot(file) {
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    await writeFile(file, Buffer.from(data, "base64"));
    return file;
  }

  async viewport(width, height) {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width < 500,
    });
  }

  async mediaScheme(scheme) {
    await this.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: scheme }],
    });
  }
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
/* --------------------------------------------------------------- helpers */

/* Injected into every document before the page's own script runs: a tiny
   read-only view of the sections, chips and group menus, so the checks below
   stay one line each instead of repeating DOM walking. */
const HELPERS = `
  window.__t = {
    text: function (selector) {
      var el = document.querySelector(selector);
      return el ? el.textContent.replace(/\\s+/g, " ").trim() : null;
    },
    counter: function () { return window.__t.text("#count"); },
    emptyState: function () {
      var el = document.getElementById("empty");
      return el ? { hidden: el.hidden, text: el.textContent.trim() } : null;
    },
    toast: function () {
      var el = document.getElementById("toast");
      return el ? { hidden: el.hidden, text: el.textContent.trim(), on: el.classList.contains("on") } : null;
    },
    theme: function () {
      var btn = document.getElementById("theme-toggle");
      var glyph = btn && btn.querySelector(".theme-glyph");
      var stored = null;
      try { stored = localStorage.getItem("boards-theme"); } catch (err) {}
      return {
        attr: document.documentElement.getAttribute("data-theme"),
        glyph: glyph ? glyph.textContent.trim() : null,
        stored: stored,
        label: btn ? btn.getAttribute("aria-label") : null,
      };
    },
    sections: function () {
      return Array.prototype.map.call(
        document.querySelectorAll("#sections .board-section"),
        function (section) { return window.__t.section(section.dataset.group); },
      );
    },
    keys: function () {
      return Array.prototype.map.call(
        document.querySelectorAll("#sections .board-section"),
        function (section) { return section.dataset.group; },
      );
    },
    section: function (key) {
      var section = document.querySelector('.board-section[data-group="' + key + '"]');
      if (!section) return null;
      var head = section.querySelector(".sect-head");
      var grid = section.querySelector(".grid");
      var cards = Array.prototype.slice.call(section.querySelectorAll(".card"));
      var slugs = cards.map(function (card) { return card.dataset.slug; });
      var unique = slugs.filter(function (slug, index) { return slugs.indexOf(slug) === index; });
      var dot = head ? head.querySelector(".dot") : null;
      var toggle = head ? head.querySelector(".sect-toggle") : null;
      var countEl = head ? head.querySelector(".sect-count") : null;
      return {
        key: key,
        name: head ? (head.querySelector(".sect-name") || {}).textContent : null,
        count: countEl ? Number(countEl.textContent.replace(/[^0-9]/g, "")) : null,
        cards: slugs,
        unique: unique,
        hidden: section.hidden,
        collapsed: section.dataset.collapsed,
        gridId: grid ? grid.id : null,
        gridDisplay: grid ? getComputedStyle(grid).display : null,
        dot: dot ? dot.className : null,
        canRename: !!section.querySelector('[data-act="group-rename"]'),
        canDelete: !!section.querySelector('[data-act="group-del"]'),
        canToggle: !!toggle,
        toggleExpanded: toggle ? toggle.getAttribute("aria-expanded") : null,
        rowCount: section.querySelectorAll(".sect-head").length,
      };
    },
    chips: function () {
      return Array.prototype.map.call(
        document.querySelectorAll("#group-chips .chip"),
        function (chip) {
          var dot = chip.querySelector(".dot");
          var n = chip.querySelector(".n");
          return {
            key: chip.dataset.group,
            label: chip.textContent.replace(/\\s+/g, " ").trim(),
            n: n ? n.textContent.trim() : null,
            pressed: chip.getAttribute("aria-pressed"),
            dot: dot ? dot.className : null,
          };
        },
      );
    },
    searchOn: function () {
      var box = document.getElementById("sections");
      return !!box && box.classList.contains("searching");
    },
    copies: function (slug) {
      return Array.prototype.map.call(
        document.querySelectorAll('.card[data-slug="' + slug + '"]'),
        function (card) { return window.__t.card(card); },
      );
    },
    card: function (card) {
      var btn = card.querySelector("button.card-group");
      var menu = card.querySelector(".group-menu");
      var boxes = menu ? Array.prototype.slice.call(menu.querySelectorAll('input[type="checkbox"]')) : [];
      return {
        slug: card.dataset.slug,
        section: card.dataset.section || "",
        label: btn ? (btn.querySelector(".lbl") || {}).textContent : null,
        expanded: btn ? btn.getAttribute("aria-expanded") : null,
        hasPopup: btn ? btn.getAttribute("aria-haspopup") : null,
        pickHidden: card.querySelector(".group-pick") ? card.querySelector(".group-pick").hidden : null,
        menuHidden: menu ? menu.hidden : null,
        boxes: boxes.map(function (box) { return box.value; }),
        checked: boxes.filter(function (box) { return box.checked; }).map(function (box) { return box.value; }),
        clear: !!menu.querySelector(".group-clear"),
        clearText: menu.querySelector(".group-clear") ? menu.querySelector(".group-clear").textContent.trim() : null,
      };
    },
    one: function (slug, key) {
      var card = document.querySelector(
        '.board-section[data-group="' + key + '"] .card[data-slug="' + slug + '"]',
      );
      return card ? window.__t.card(card) : null;
    },
    visibleMenus: function () {
      return Array.prototype.filter
        .call(document.querySelectorAll(".card .group-menu"), function (menu) { return !menu.hidden; })
        .map(function (menu) {
          var card = menu.closest(".card");
          return { slug: card.dataset.slug, section: card.dataset.section || "" };
        });
    },
    menuBox: function (slug) {
      var menu = Array.prototype.filter
        .call(document.querySelectorAll('.card[data-slug="' + slug + '"] .group-menu'), function (m) { return !m.hidden; })[0];
      if (!menu) return null;
      var card = menu.closest(".card").getBoundingClientRect();
      var box = menu.getBoundingClientRect();
      return {
        card: { left: card.left, right: card.right, top: card.top, bottom: card.bottom, width: card.width, height: card.height },
        menu: { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height },
      };
    },
    overflow: function () {
      var el = document.documentElement;
      return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, scrollHeight: el.scrollHeight };
    },
    focused: function () {
      var el = document.activeElement;
      if (!el) return null;
      return {
        tag: el.tagName.toLowerCase(),
        cls: String(el.className || ""),
        slug: el.dataset ? (el.dataset.slug || el.dataset.group || "") : "",
      };
    },
    modal: function (id) {
      var el = document.getElementById(id);
      return el ? { hidden: el.hidden } : null;
    },
    note: function (id) {
      var el = document.getElementById(id);
      return el ? { hidden: el.hidden, text: el.textContent.trim() } : null;
    },
    focusVisible: function (selector) {
      var el = document.querySelector(selector);
      if (!el) return null;
      el.focus();
      var style = getComputedStyle(el);
      return { outline: style.outlineStyle, width: style.outlineWidth };
    },
  };
`;

/**
 * Launch headless Chrome on a free port and wait for the DevTools endpoint.
 * about:blank first: opening the catalogue straight from argv can close the
 * page socket before the harness attaches.
 */
async function launchChrome() {
  const port = await freePort();
  const profile = await mkdtemp(path.join(os.tmpdir(), "catalog-groups-profile-"));
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
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-features=Translate,BackForwardCache",
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      "--window-size=1440,900",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const cleanup = () => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    try {
      rm(profile, { recursive: true, force: true });
    } catch {
      /* windows locks the profile */
    }
  };
  process.on("exit", cleanup);
  const deadline = Date.now() + 20000;
  let targets = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (res.ok) {
        targets = await res.json();
        if (targets.some((target) => target.type === "page" && target.webSocketDebuggerUrl)) break;
      }
    } catch {
      /* not listening yet */
    }
    await sleep(120);
  }
  if (!targets) throw new Error("Chrome did not open a DevTools endpoint");
  const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
  if (!page) throw new Error("Chrome has no page target");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  return { ws, port, kill: () => { try { child.kill("SIGKILL"); } catch {} } };
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const tmp = await mkdtemp(path.join(os.tmpdir(), "catalog-groups-"));
  const scenesDir = path.join(tmp, "scenes");
  const siteDir = path.join(tmp, "site");
  await mkdir(path.join(siteDir, "thumbs"), { recursive: true });
  await mkdir(path.join(siteDir, "scenes"), { recursive: true });

  /* three scenes, each with a preview the build can reuse without rendering */
  const tints = [
    [86, 118, 214],
    [58, 168, 148],
    [176, 150, 104],
  ];
  for (const [index, seed] of SEEDS.entries()) {
    const dir = path.join(scenesDir, seed.id);
    await mkdir(dir, { recursive: true });
    const scene = {
      type: "excalidraw",
      version: 2,
      source: "test-catalog-groups",
      elements: [],
      appState: { viewBackgroundColor: "#ffffff" },
      files: {},
    };
    await writeFile(path.join(dir, "scene.excalidraw"), JSON.stringify(scene, null, 2));
    const [r, g, b] = tints[index];
    const png = encodePng(360, 220, (x, y) => {
      const wash = 0.55 + 0.35 * (1 - y / 220);
      const band = x < 40 || x > 320 ? 1 : 0.92;
      return [Math.round(r * wash * band), Math.round(g * wash * band), Math.round(b * wash * band)];
    });
    await writeFile(path.join(siteDir, "thumbs", `${seed.id}.png`), png);
  }

  /* the catalogue itself: SCENES_DIR/SITE_DIR point it at this throwaway tree */
  const buildOut = execFileSync(process.execPath, ["gallery/build.mjs", "--no-render"], {
    cwd: ROOT,
    env: { ...process.env, SCENES_DIR: scenesDir, SITE_DIR: siteDir },
    encoding: "utf8",
  });
  check("build: catalogue written without rendering", buildOut.includes("building 3 board(s)"), buildOut.trim());
  const indexHtml = await readFile(path.join(siteDir, "index.html"), "utf8");
  const cardTags = indexHtml.match(/<article class="card"[^>]*>/g) || [];
  check(
    "build: html carries data-slug and data-groups on every card",
    cardTags.length === 3 &&
      cardTags.every((tag) => / data-slug="[^"]+"/.test(tag) && / data-groups="[^"]*"/.test(tag)),
    `${cardTags.length} card tags`,
  );
  check("build: html ships the multi-select menu markup, not the old select", indexHtml.includes('class="group-menu"') && indexHtml.includes('aria-haspopup="true"') && !indexHtml.includes("select class=\"card-group\""));
  const manifest = JSON.parse(await readFile(path.join(siteDir, "manifest.json"), "utf8"));
  const manifestBoards = Array.isArray(manifest.boards) ? manifest.boards : [];
  check("build: manifest lists 3 boards with a groupIds array", manifestBoards.length === 3 && manifestBoards.every((board) => Array.isArray(board.groupIds)), `${manifestBoards.length} boards`);

  /* stub API */
  const stub = createStub(siteDir, SEEDS.map((seed) => seed.id));
  await new Promise((resolve) => stub.server.listen(0, "127.0.0.1", resolve));
  const apiPort = stub.server.address().port;
  const base = `http://127.0.0.1:${apiPort}`;

  const requestLog = () => stub.state.log;
  const metaWrites = () => requestLog().filter((entry) => entry.method === "PATCH" && /^\/api\/boards\/[^/]+\/meta$/.test(entry.path));
  const membershipOf = (slug) => (stub.state.membership.get(slug) || []).slice();
  const settled = (label) => cdp.waitFor(`(__t.keys().length === 3 && __t.sections().every((s) => s.count === s.cards.length))`, { label });

  const chrome = await launchChrome();
  let cdp;
  try {
    cdp = new CDP(chrome.ws);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Page.bringToFront");
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: HELPERS });
    await cdp.viewport(1440, 900);
    await cdp.mediaScheme("light");
    await cdp.navigate(base + "/index.html");
    await cdp.waitFor(`typeof __t === "object" && __t.keys().length === 3`, { label: "sections rendered" });
    await settled("initial sections");

    /* ------------------------------------------------------------ sections */
    const keys = await cdp.evaluate("__t.keys()");
    check("sections: one per group plus __none__, in group order", JSON.stringify(keys) === JSON.stringify([G1, G2, "__none__"]), JSON.stringify(keys));

    const alphaCopies = await cdp.evaluate(`__t.copies(${JSON.stringify(SEEDS[0].id)})`);
    check("sections: a board in two groups has two copies, one per section", alphaCopies.length === 2 && alphaCopies.every((copy) => copy.section === G1 || copy.section === G2), JSON.stringify(alphaCopies.map((copy) => copy.section)));

    const g1 = await cdp.evaluate(`__t.section(${JSON.stringify(G1)})`);
    check("sections: group one shows alpha and beta", JSON.stringify(g1.unique.slice().sort()) === JSON.stringify([SEEDS[0].id, SEEDS[1].id].sort()), JSON.stringify(g1.unique));
    const g2 = await cdp.evaluate(`__t.section(${JSON.stringify(G2)})`);
    check("sections: group two shows only alpha", JSON.stringify(g2.unique) === JSON.stringify([SEEDS[0].id]), JSON.stringify(g2.unique));
    const none = await cdp.evaluate("__t.section('__none__')");
    check("sections: no-group board sits only in ไม่มีหมวดหมู่", JSON.stringify(none.unique) === JSON.stringify([SEEDS[2].id]), JSON.stringify(none.unique));
    check("sections: a board in a group is absent from __none__", !none.cards.includes(SEEDS[0].id) && !none.cards.includes(SEEDS[1].id));
    check("sections: each heading count equals the cards it shows", [g1, g2, none].every((section) => section.count === section.cards.length), `${g1.count}/${g2.count}/${none.count}`);

    /* ----------------------------------------------------------------- chips */
    const chips = await cdp.evaluate("__t.chips()");
    check("chips: ทั้งหมด shows the board total", chips[0] && chips[0].key === "all" && chips[0].n === "3", JSON.stringify(chips[0]));
    const chipG1 = chips.find((chip) => chip.key === G1);
    const chipG2 = chips.find((chip) => chip.key === G2);
    check("chips: a board in two groups is counted in both", chipG1 && chipG1.n === "2" && chipG2 && chipG2.n === "1", `${chipG1 && chipG1.n}/${chipG2 && chipG2.n}`);
    check("chips: chip carries the group colour dot", Boolean(chipG1 && chipG1.dot.includes("violet") && chipG2 && chipG2.dot.includes("teal")), `${chipG1 && chipG1.dot} | ${chipG2 && chipG2.dot}`);

    /* ------------------------------------------------- triggers and labels */
    const labels = [];
    for (const [slug, sectionKey] of [
      [SEEDS[0].id, G1],
      [SEEDS[0].id, G2],
      [SEEDS[1].id, G1],
      [SEEDS[2].id, "__none__"],
    ]) {
      labels.push(await cdp.evaluate(`__t.one(${JSON.stringify(slug)}, ${JSON.stringify(sectionKey)})`));
    }
    check(
      "trigger label: 2 groups reads “2 หมวด” on every copy",
      labels[0].label === "2 หมวด" && labels[1].label === "2 หมวด",
      `${labels[0].label} | ${labels[1].label}`,
    );
    check("trigger label: 1 group reads the group name", labels[2].label === "ลูกค้า", labels[2].label);
    check("trigger label: no group reads ไม่มีหมวด", labels[3].label === "ไม่มีหมวด", labels[3].label);
    check(
      "trigger: every copy is an aria-haspopup button with a closed menu",
      labels.every((copy) => copy.hasPopup === "true" && copy.menuHidden === true && copy.expanded === "false" && copy.pickHidden === false),
      JSON.stringify(labels.map((copy) => [copy.hasPopup, copy.menuHidden, copy.expanded, copy.pickHidden])),
    );

    /* ------------------------------------------------------- opening a menu */
    const alphaTrigger = `.board-section[data-group="${G1}"] .card[data-slug="${SEEDS[0].id}"] button.card-group`;
    await cdp.click(alphaTrigger);
    await cdp.waitFor("__t.visibleMenus().length === 1", { label: "menu opens" });
    const opened = await cdp.evaluate(`__t.one(${JSON.stringify(SEEDS[0].id)}, ${JSON.stringify(G1)})`);
    check(
      "menu: opening lists one checkbox per group and a ล้างหมวด action",
      JSON.stringify(opened.boxes) === JSON.stringify([G1, G2]) && opened.checked.length === 2 && opened.clear && opened.clearText === "ล้างหมวด",
      JSON.stringify(opened.boxes),
    );
    check("menu: the trigger reports aria-expanded and the menu is visible", opened.expanded === "true" && opened.menuHidden === false);
    check(
      "menu: only the copy that was clicked opens",
      JSON.stringify(await cdp.evaluate("__t.visibleMenus()")) === JSON.stringify([{ slug: SEEDS[0].id, section: G1 }]),
      JSON.stringify(await cdp.evaluate("__t.visibleMenus()")),
    );
    const box = await cdp.evaluate(`__t.menuBox(${JSON.stringify(SEEDS[0].id)})`);
    check(
      "menu: the panel stays inside its card (no overflow)",
      box && box.menu.left >= box.card.left - 1 && box.menu.right <= box.card.right + 1 && box.menu.top >= box.card.top - 1 && box.menu.bottom <= box.card.bottom + 1,
      box ? `menu ${Math.round(box.menu.left)}..${Math.round(box.menu.right)} card ${Math.round(box.card.left)}..${Math.round(box.card.right)}` : "no box",
    );

    await cdp.press("Escape", "Escape", 27);
    await cdp.waitFor("__t.visibleMenus().length === 0", { label: "escape closes menu" });
    const afterEscape = await cdp.evaluate("__t.focused()");
    check("menu: Escape closes it and returns focus to the trigger", afterEscape && afterEscape.cls.includes("card-group") && afterEscape.slug === SEEDS[0].id, JSON.stringify(afterEscape));

    const gammaTrigger = `.board-section[data-group="__none__"] .card[data-slug="${SEEDS[2].id}"] button.card-group`;
    await cdp.click(gammaTrigger);
    await cdp.waitFor("__t.visibleMenus().length === 1", { label: "second menu opens" });
    await cdp.click("#count");
    await cdp.waitFor("__t.visibleMenus().length === 0", { label: "outside click closes menu" });
    check("menu: an outside click closes it", (await cdp.evaluate("__t.visibleMenus().length")) === 0);

    await cdp.click(gammaTrigger);
    await cdp.waitFor("__t.visibleMenus().length === 1", { label: "menu reopens" });
    await cdp.click(alphaTrigger);
    await cdp.waitFor("__t.visibleMenus().length === 1", { label: "one menu at a time" });
    const onlyOne = await cdp.evaluate("__t.visibleMenus()");
    check("menu: opening another card's menu closes the first", onlyOne.length === 1 && onlyOne[0].slug === SEEDS[0].id, JSON.stringify(onlyOne));

    const stillTwo = await cdp.evaluate(
      `(() => ({ label: __t.one(${JSON.stringify(SEEDS[0].id)}, ${JSON.stringify(G1)}).label }))()`,
    );
    check("menu: the open card still reads “2 หมวด”", stillTwo.label === "2 หมวด", stillTwo.label);

    /* screenshots: menu open on a two-group card, light theme */
    await cdp.quiet();
    const menuShot = await cdp.screenshot(path.join(OUT, "menu-light.png"));
    check("shots: menu screenshot captured", existsSync(menuShot), menuShot);
/* ------------------------------------------------------------ part three */

async function until(predicate, label, timeout = 9000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(70);
  }
  throw new Error(`timeout: ${label}`);
}

const sectionSel = (key) => `.board-section[data-group="${key}"]`;
const cardSel = (key, slug) => `${sectionSel(key)} .card[data-slug="${slug}"]`;
const triggerSel = (key, slug) => `${cardSel(key, slug)} button.card-group`;
const boxSel = (key, slug, groupId) => `${cardSel(key, slug)} .group-menu input[value="${groupId}"]`;

const visibleRows = () =>
  cdp.evaluate(`(() => Array.prototype.map.call(document.querySelectorAll(".board-section"), (section) => {
    const shown = Array.prototype.filter.call(section.querySelectorAll(".card"), (card) => !card.hidden);
    return { key: section.dataset.group, hidden: section.hidden, shown: shown.map((card) => card.dataset.slug) };
  }))()`);

const openMenuAt = async (key, slug) => {
  /* the menu stays open across a tick by design, so opening is idempotent: a
     second click on an open trigger would close it again. The open menu can
     still sit on the section the card is leaving, so wait for the card to land. */
  const openHere = `__t.visibleMenus().length === 1 && __t.visibleMenus()[0].slug === ${JSON.stringify(slug)} && __t.visibleMenus()[0].section === ${JSON.stringify(key)}`;
  if (await cdp.evaluate(openHere)) return;
  await cdp.waitFor(`__t.section(${JSON.stringify(key)}).unique.includes(${JSON.stringify(slug)})`, {
    label: `${slug} drawn in ${key}`,
  });
  if (await cdp.evaluate("__t.visibleMenus().length")) {
    await cdp.press("Escape", "Escape", 27);
    await cdp.waitFor("__t.visibleMenus().length === 0", { label: "menu closed before reopening" });
  }
  await cdp.click(triggerSel(key, slug));
  await cdp.waitFor(openHere, { label: `menu for ${slug} in ${key}` });
};

const closeMenus = async () => {
  if (await cdp.evaluate("__t.visibleMenus().length")) {
    await cdp.press("Escape", "Escape", 27);
    await cdp.waitFor("__t.visibleMenus().length === 0", { label: "menus closed" });
  }
};

/* focus the field first: clicking a chip moves focus off #q, and a bare
   Backspace would then go nowhere */
const clearQuery = async () => {
  await cdp.click("#q");
  await cdp.evaluate(`(() => { const input = document.getElementById("q"); input.select(); })()`);
  await cdp.backspace(1);
};

/* dialog fields arrive pre-filled (the current group name / board title), and
   insertText appends at the caret, so clear the field before typing */
const fillField = async (selector, text) => {
  await cdp.click(selector);
  await cdp.evaluate(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); input.select(); })()`);
  await cdp.backspace(1);
  await cdp.type(text);
};

const countBy = (list) => list.reduce((acc, item) => ((acc[item] = (acc[item] || 0) + 1), acc), {});

/* ------------------------------ one tick moves a board into a second group */
await closeMenus();
const writesBefore = metaWrites().length;
await openMenuAt(G1, SEEDS[1].id);
await cdp.click(boxSel(G1, SEEDS[1].id, G2));
await until(() => JSON.stringify(membershipOf(SEEDS[1].id)) === JSON.stringify([G1, G2]), "beta membership [G1,G2]");
await cdp.waitFor(`__t.section(${JSON.stringify(G2)}).unique.includes(${JSON.stringify(SEEDS[1].id)})`, { label: "beta appears in G2" });
const tickWrites = metaWrites().slice(writesBefore);
check("tick: one tick sends exactly one PATCH", tickWrites.length === 1, `${tickWrites.length} writes`);
check(
  "tick: the PATCH body is { groupIds: [...] } with both ids",
  tickWrites.length === 1 &&
    tickWrites[0].body &&
    JSON.stringify(Object.keys(tickWrites[0].body)) === JSON.stringify(["groupIds"]) &&
    tickWrites[0].body.groupIds.length === 2 &&
    tickWrites[0].body.groupIds.includes(G1) &&
    tickWrites[0].body.groupIds.includes(G2),
  JSON.stringify(tickWrites[0] && tickWrites[0].body),
);
check("tick: the server now holds both ids for the board", JSON.stringify(membershipOf(SEEDS[1].id)) === JSON.stringify([G1, G2]), JSON.stringify(membershipOf(SEEDS[1].id)));
const betaCopies = await cdp.evaluate(`__t.copies(${JSON.stringify(SEEDS[1].id)})`);
check(
  "tick: the board is now drawn in both sections with the “2 หมวด” label",
  betaCopies.length === 2 && betaCopies.every((copy) => copy.label === "2 หมวด") &&
    betaCopies.map((copy) => copy.section).sort().join() === [G1, G2].sort().join(),
  JSON.stringify(betaCopies.map((copy) => [copy.section, copy.label])),
);
const g1AfterTick = await cdp.evaluate(`__t.section(${JSON.stringify(G1)})`);
const g2AfterTick = await cdp.evaluate(`__t.section(${JSON.stringify(G2)})`);
const noneAfterTick = await cdp.evaluate("__t.section('__none__')");
check(
  "tick: heading counts follow the cards (2/2/1)",
  g1AfterTick.count === 2 && g2AfterTick.count === 2 && noneAfterTick.count === 1,
  `${g1AfterTick.count}/${g2AfterTick.count}/${noneAfterTick.count}`,
);
check(
  "tick: the menu stays open on the same board for further toggles",
  JSON.stringify(await cdp.evaluate("__t.visibleMenus()")).includes(SEEDS[1].id),
  JSON.stringify(await cdp.evaluate("__t.visibleMenus()")),
);
check(
  "tick: every checkbox of the new member is ticked on both copies",
  betaCopies.every((copy) => copy.checked.length === 2 && copy.checked.includes(G1) && copy.checked.includes(G2)),
  JSON.stringify(betaCopies.map((copy) => copy.checked)),
);

/* ---------------------------- untick one of two leaves the other in place */
const writesBeforeUntick = metaWrites().length;
await cdp.click(boxSel(G1, SEEDS[1].id, G2));
await until(() => JSON.stringify(membershipOf(SEEDS[1].id)) === JSON.stringify([G1]), "beta membership [G1]");
await cdp.waitFor(`!__t.section(${JSON.stringify(G2)}).unique.includes(${JSON.stringify(SEEDS[1].id)})`, { label: "beta leaves G2" });
const untickWrites = metaWrites().slice(writesBeforeUntick);
check(
  "untick: one PATCH with only the remaining id",
  untickWrites.length === 1 && JSON.stringify(untickWrites[0].body) === JSON.stringify({ groupIds: [G1] }),
  JSON.stringify(untickWrites[0] && untickWrites[0].body),
);
const betaAlone = await cdp.evaluate(`__t.copies(${JSON.stringify(SEEDS[1].id)})`);
check("untick: the card is back in one section and reads the group name", betaAlone.length === 1 && betaAlone[0].section === G1 && betaAlone[0].label === "ลูกค้า", JSON.stringify(betaAlone.map((copy) => [copy.section, copy.label])));

/* ------------------------ the last group: no group board → one group → none */
await closeMenus();
await openMenuAt("__none__", SEEDS[2].id);
check("clear path: a no-group board opens a menu with nothing ticked", (await cdp.evaluate(`__t.one(${JSON.stringify(SEEDS[2].id)}, "__none__")`)).checked.length === 0);
await cdp.click(boxSel("__none__", SEEDS[2].id, G2));
await until(() => JSON.stringify(membershipOf(SEEDS[2].id)) === JSON.stringify([G2]), "gamma membership [G2]");
await cdp.waitFor(`__t.section(${JSON.stringify(G2)}).unique.includes(${JSON.stringify(SEEDS[2].id)}) && !__t.section("__none__").unique.includes(${JSON.stringify(SEEDS[2].id)})`, { label: "gamma moved to G2" });
const gammaInG2 = await cdp.evaluate(`__t.one(${JSON.stringify(SEEDS[2].id)}, ${JSON.stringify(G2)})`);
check("tick from none: the board leaves ไม่มีหมวดหมู่ and reads its group name", gammaInG2.label === "งานภายใน" && gammaInG2.checked.join() === G2, JSON.stringify([gammaInG2.label, gammaInG2.checked]));

const writesBeforeEmpty = metaWrites().length;
await cdp.click(boxSel(G2, SEEDS[2].id, G2));
await until(() => membershipOf(SEEDS[2].id).length === 0, "gamma membership cleared");
await cdp.waitFor(`__t.section("__none__").unique.includes(${JSON.stringify(SEEDS[2].id)})`, { label: "gamma back in none" });
const emptyWrites = metaWrites().slice(writesBeforeEmpty);
check(
  "untick the last group: the body carries an empty groupIds array",
  emptyWrites.length === 1 && JSON.stringify(emptyWrites[0].body) === JSON.stringify({ groupIds: [] }),
  JSON.stringify(emptyWrites[0] && emptyWrites[0].body),
);
const gammaBack = await cdp.evaluate(`__t.one(${JSON.stringify(SEEDS[2].id)}, "__none__")`);
check("untick the last group: the card moves to ไม่มีหมวดหมู่", gammaBack.label === "ไม่มีหมวด" && gammaBack.checked.length === 0, JSON.stringify([gammaBack.label, gammaBack.checked]));

/* ------------------------------------------- ล้างหมวด clears a multi-group card */
await closeMenus();
await openMenuAt(G1, SEEDS[0].id);
await cdp.click(`${cardSel(G1, SEEDS[0].id)} .group-clear`);
await until(() => membershipOf(SEEDS[0].id).length === 0, "alpha cleared");
await cdp.waitFor(`__t.section("__none__").unique.includes(${JSON.stringify(SEEDS[0].id)})`, { label: "alpha moved to none" });
check(
  "ล้างหมวด: sends groupIds: [] and moves the two-group card to ไม่มีหมวดหมู่",
  JSON.stringify(membershipOf(SEEDS[0].id)) === "[]" &&
    !(await cdp.evaluate(`__t.section(${JSON.stringify(G1)}).unique.includes(${JSON.stringify(SEEDS[0].id)})`)),
  JSON.stringify(membershipOf(SEEDS[0].id)),
);
check("ล้างหมวด: the card reads ไม่มีหมวด afterwards", (await cdp.evaluate(`__t.one(${JSON.stringify(SEEDS[0].id)}, "__none__")`)).label === "ไม่มีหมวด");
/* put alpha back where the rest of the run expects it */
await openMenuAt("__none__", SEEDS[0].id);
await cdp.click(boxSel("__none__", SEEDS[0].id, G1));
await until(() => JSON.stringify(membershipOf(SEEDS[0].id)) === JSON.stringify([G1]), "alpha back in G1");
await openMenuAt(G1, SEEDS[0].id);
await cdp.click(boxSel(G1, SEEDS[0].id, G2));
await until(() => JSON.stringify(membershipOf(SEEDS[0].id)) === JSON.stringify([G1, G2]), "alpha back in G1+G2");
await cdp.waitFor(`__t.copies(${JSON.stringify(SEEDS[0].id)}).length === 2`, { label: "alpha two copies again" });
check("restore: alpha is back in two groups for the rest of the run", (await cdp.evaluate(`__t.copies(${JSON.stringify(SEEDS[0].id)})`)).length === 2);

/* ----------------------------------------- a rejected PATCH reverts the tick */
await closeMenus();
await openMenuAt(G1, SEEDS[0].id);
const beforeReject = await cdp.evaluate(`__t.one(${JSON.stringify(SEEDS[0].id)}, ${JSON.stringify(G1)})`);
stub.state.rejectMetaOnce = true;
await cdp.click(boxSel(G1, SEEDS[0].id, G2));
await cdp.waitFor(`(__t.toast().text || "").indexOf("ยังไม่ได้บันทึก") >= 0`, { label: "error toast" });
const afterReject = await cdp.evaluate(`__t.one(${JSON.stringify(SEEDS[0].id)}, ${JSON.stringify(G1)})`);
const rejectToast = await cdp.evaluate("__t.toast()");
check("404: an unknown group id keeps the server membership untouched", JSON.stringify(membershipOf(SEEDS[0].id)) === JSON.stringify([G1, G2]), JSON.stringify(membershipOf(SEEDS[0].id)));
check(
  "404: the checkbox the person just ticked is reverted",
  afterReject.checked.sort().join() === beforeReject.checked.sort().join() && afterReject.checked.includes(G2),
  JSON.stringify(afterReject.checked),
);
check("404: an error toast explains the write did not land", rejectToast.hidden === false && rejectToast.text.includes("ไม่พบหมวดหรือกระดานนี้แล้ว"), JSON.stringify(rejectToast));
check("404: no extra section copy appeared", (await cdp.evaluate(`__t.copies(${JSON.stringify(SEEDS[0].id)})`)).length === 2);

/* ------------------------------------------------- chip filter with copies */
await closeMenus();
await cdp.click(`#group-chips .chip[data-group="${G1}"]`);
await cdp.waitFor("__t.chips().find((chip) => chip.key === \"all\").pressed === \"false\"", { label: "chip aria state" });
const chipRows = await visibleRows();
check(
  "chip: a group chip shows only that group's section",
  chipRows.filter((row) => !row.hidden).map((row) => row.key).join() === G1,
  JSON.stringify(chipRows.map((row) => [row.key, row.hidden])),
);
check("chip: the counter reads how many of the total are shown", (await cdp.evaluate("__t.text('#count')")) === "2 จาก 3", await cdp.evaluate("__t.text('#count')"));
check(
  "chip: a two-group board still appears once, in its own section",
  (await cdp.evaluate(`(() => Array.prototype.filter.call(document.querySelectorAll('.card[data-slug="${SEEDS[0].id}"]'), (card) => !card.hidden).length)()`)) === 1,
);
await cdp.click(`#group-chips .chip[data-group="${G2}"]`);
await cdp.waitFor("__t.text('#count') === \"1 จาก 3\"", { label: "G2 chip" });
check("chip: switching chips re-scopes without duplicating cards", (await cdp.evaluate(`(() => __t.section(${JSON.stringify(G2)}).unique)()`)).length === 1);
await cdp.click(`#group-chips .chip[data-group="all"]`);
await cdp.waitFor("__t.text('#count') === \"3 กระดาน\"", { label: "back to all" });
check("chip: ทั้งหมด restores every section", (await visibleRows()).every((row) => !row.hidden));

/* ------------------------------------------------------- search + copies */
await cdp.click("#q");
await cdp.type("alpha");
await cdp.waitFor("__t.sections().every((section) => section.hidden || section.unique.length === section.cards.length)", { label: "search applied" });
const searchState = await cdp.evaluate("({ counter: __t.text('#count'), searching: __t.searchOn(), empty: __t.emptyState() })");
check("search: counts the board once, not once per section", searchState.counter === "1 จาก 3", searchState.counter);
check("search: sets #sections.searching and keeps the honest empty state hidden", searchState.searching === true && searchState.empty.hidden === true, JSON.stringify(searchState.empty));
const searchRows = await visibleRows();
check(
  "search: a board found in two sections shows one card per section, never twice in one",
  searchRows.every((row) => row.shown.length === new Set(row.shown).size),
  JSON.stringify(searchRows.map((row) => row.shown)),
);
check(
  "search: the two copies of the matched board are both visible",
  (await cdp.evaluate(`(() => Array.prototype.filter.call(document.querySelectorAll('.card[data-slug="${SEEDS[0].id}"]'), (card) => !card.hidden).length)()`)) === 2,
);
check("search: non-matching boards are hidden", (await cdp.evaluate(`(() => Array.prototype.filter.call(document.querySelectorAll('.card[data-slug="${SEEDS[1].id}"]'), (card) => !card.hidden).length)()`)) === 0);
await cdp.click(`#group-chips .chip[data-group="${G1}"]`);
await cdp.waitFor("__t.text('#count') === \"1 จาก 3\"", { label: "chip and query intersect" });
const intersect = await visibleRows();
check(
  "search ∩ chip: only the chip's section survives, still once",
  intersect.filter((row) => !row.hidden).map((row) => row.key).join() === G1 &&
    (intersect.find((row) => row.key === G1) || { shown: [] }).shown.join() === SEEDS[0].id,
  JSON.stringify(intersect.map((row) => [row.key, row.hidden, row.shown])),
);
await clearQuery();
await cdp.waitFor("__t.text('#count') === \"2 จาก 3\"", { label: "query cleared under chip" });
await cdp.click(`#group-chips .chip[data-group="all"]`);
await cdp.waitFor("__t.text('#count') === \"3 กระดาน\"", { label: "chip cleared" });
check("search: clearing the query leaves the page exactly as before", (await visibleRows()).every((row) => !row.hidden) && (await cdp.evaluate("__t.searchOn()")) === false);

/* -------------------------------------- folding a section that has copies */
await closeMenus();
await cdp.click(`${sectionSel(G1)} .sect-toggle`);
await cdp.waitFor(`__t.section(${JSON.stringify(G1)}).collapsed === "1"`, { label: "G1 folded" });
const folded = await cdp.evaluate(`__t.section(${JSON.stringify(G1)})`);
check("fold: the toggle collapses the section and hides its grid", folded.collapsed === "1" && folded.gridDisplay === "none" && folded.toggleExpanded === "false", JSON.stringify([folded.collapsed, folded.gridDisplay]));
await cdp.click("#q");
await cdp.type("alpha");
await cdp.waitFor("__t.searchOn() === true", { label: "searching" });
check("fold: a search reveals the folded section's cards", (await cdp.evaluate(`__t.section(${JSON.stringify(G1)}).gridDisplay`)) === "grid");
check("fold: the folded section still holds both of its cards", (await cdp.evaluate(`__t.section(${JSON.stringify(G1)}).cards.length`)) === 2);
await clearQuery();
await cdp.waitFor("__t.searchOn() === false", { label: "search cleared" });
check("fold: clearing the search folds it again", (await cdp.evaluate(`__t.section(${JSON.stringify(G1)}).gridDisplay`)) === "none");
await cdp.reload();
await cdp.waitFor(`typeof __t === "object" && __t.keys().length === 3`, { label: "reload after fold" });
await until(async () => JSON.stringify(membershipOf(SEEDS[0].id)) === JSON.stringify([G1, G2]), "membership after reload");
await cdp.waitFor(`__t.section(${JSON.stringify(G1)}).collapsed === "1"`, { label: "fold persisted" });
check("fold: the collapsed section survives a reload", (await cdp.evaluate(`__t.section(${JSON.stringify(G1)}).gridDisplay`)) === "none");
await cdp.click(`${sectionSel(G1)} .sect-toggle`);
await cdp.waitFor(`__t.section(${JSON.stringify(G1)}).collapsed === "0"`, { label: "G1 unfolded" });
check("fold: unfolding shows the grid again", (await cdp.evaluate(`__t.section(${JSON.stringify(G1)}).gridDisplay`)) === "grid");

/* ------------------------------------------------------------ create group */
await cdp.click("#group-new");
await cdp.waitFor("document.getElementById('group-modal').hidden === false", { label: "group modal" });
await cdp.click(`#group-colors input[value="amber"]`);
await fillField("#group-name", "ทดสอบหมวดใหม่");
check("create: dialog title and save label switch to the new-group copy", (await cdp.evaluate("__t.text('#group-modal-title')")) === "หมวดใหม่" && (await cdp.evaluate("__t.text('#group-save')")) === "สร้างหมวด");
const postsBefore = requestLog().filter((entry) => entry.method === "POST" && entry.path === "/api/groups").length;
await cdp.click("#group-save");
await cdp.waitFor("__t.keys().length === 4", { label: "four sections" });
const created = await cdp.evaluate("__t.chips()");
const g3chip = created[created.length - 1];
const G3 = g3chip.key;
const postWrites = requestLog().filter((entry) => entry.method === "POST" && entry.path === "/api/groups").slice(postsBefore);
check("create: POST carries the name and the picked colour", postWrites.length === 1 && postWrites[0].body.name === "ทดสอบหมวดใหม่" && postWrites[0].body.color === "amber", JSON.stringify(postWrites[0] && postWrites[0].body));
check("create: the new group gets a section and a chip", G3.startsWith("grp_") && (await cdp.evaluate(`__t.keys()[2] === ${JSON.stringify(G3)}`)) === true, G3);
check("create: an empty new group shows zero cards in its heading", (await cdp.evaluate(`__t.section(${JSON.stringify(G3)}).count`)) === 0);
check("create: the dialog closes and a toast confirms", (await cdp.evaluate("__t.modal('group-modal').hidden")) === true && (await cdp.evaluate("__t.toast().text")).includes("ทดสอบหมวดใหม่"));
check(
  "create: every menu now offers the third group",
  (await cdp.evaluate(`__t.one(${JSON.stringify(SEEDS[0].id)}, ${JSON.stringify(G2)}).boxes.length`)) === 3,
  String(await cdp.evaluate(`__t.one(${JSON.stringify(SEEDS[0].id)}, ${JSON.stringify(G2)}).boxes.length`)),
);

/* ------------------------------ alpha joins the third group: three sections */
await closeMenus();
await openMenuAt(G1, SEEDS[0].id);
await cdp.click(boxSel(G1, SEEDS[0].id, G3));
await until(() => membershipOf(SEEDS[0].id).includes(G3), "alpha in G3");
await cdp.waitFor(`__t.copies(${JSON.stringify(SEEDS[0].id)}).length === 3`, { label: "alpha three copies" });
const threeCopies = await cdp.evaluate(`__t.copies(${JSON.stringify(SEEDS[0].id)})`);
check("three groups: one card per section, each labelled “3 หมวด”", threeCopies.length === 3 && threeCopies.every((copy) => copy.label === "3 หมวด"), JSON.stringify(threeCopies.map((copy) => copy.section)));
check("three groups: the section count follows the copies", (await cdp.evaluate(`__t.section(${JSON.stringify(G3)}).count`)) === 1);
check("three groups: the PATCH keeps all three ids", JSON.stringify(membershipOf(SEEDS[0].id)) === JSON.stringify([G1, G2, G3]), JSON.stringify(membershipOf(SEEDS[0].id)));
check("three groups: the chip count follows the membership", (await cdp.evaluate(`__t.chips().find((chip) => chip.key === ${JSON.stringify(G3)}).n`)) === "1");

/* put gamma into the new group so delete has a board that leaves for none */
await closeMenus();
await openMenuAt("__none__", SEEDS[2].id);
await cdp.click(boxSel("__none__", SEEDS[2].id, G3));
await until(() => JSON.stringify(membershipOf(SEEDS[2].id)) === JSON.stringify([G3]), "gamma only in G3");
await cdp.waitFor(`!__t.section("__none__").unique.includes(${JSON.stringify(SEEDS[2].id)})`, { label: "gamma left none" });
check("before delete: gamma sits only in the new group", (await cdp.evaluate(`__t.copies(${JSON.stringify(SEEDS[2].id)})`)).length === 1 && (await cdp.evaluate(`__t.one(${JSON.stringify(SEEDS[2].id)}, ${JSON.stringify(G3)}).label`)) === "ทดสอบหมวดใหม่");

/* ------------------------------------------------------------ delete group */
await closeMenus();
await cdp.click(`${sectionSel(G3)} [data-act="group-del"]`);
await cdp.waitFor("__t.modal('group-del-modal').hidden === false", { label: "group delete dialog" });
const deleteNote = await cdp.evaluate("__t.text('#group-del-detail')");
check("delete: the dialog counts the boards and explains who moves where", deleteNote.includes("2 ใบ") && deleteNote.includes("ไม่มีหมวดอื่น"), deleteNote);
await cdp.click("#group-del-confirm");
await cdp.waitFor(`__t.keys().length === 3 && !__t.keys().includes(${JSON.stringify(G3)})`, { label: "group removed" });
await cdp.waitFor(`__t.section("__none__").unique.includes(${JSON.stringify(SEEDS[2].id)})`, { label: "gamma to none" });
const delToast = await cdp.evaluate("__t.toast()");
check("delete: the multi-group board keeps its other memberships", JSON.stringify(membershipOf(SEEDS[0].id)) === JSON.stringify([G1, G2]), JSON.stringify(membershipOf(SEEDS[0].id)));
check("delete: the single-group board loses its only group and lands in ไม่มีหมวดหมู่", membershipOf(SEEDS[2].id).length === 0 && (await cdp.evaluate(`__t.one(${JSON.stringify(SEEDS[2].id)}, "__none__").label`)) === "ไม่มีหมวด");
check("delete: two cards now, so the copy count follows", (await cdp.evaluate(`__t.copies(${JSON.stringify(SEEDS[0].id)}).length`)) === 2);
check("delete: the toast reports one moved to none and one still in another group", delToast.text.includes("ย้าย 1 ใบไปไม่มีหมวดหมู่") && delToast.text.includes("1 ใบยังอยู่ในหมวดอื่น"), delToast.text);

/* ------------------------------------------------------------ rename group */
await cdp.click(`${sectionSel(G1)} [data-act="group-rename"]`);
await cdp.waitFor("__t.modal('group-modal').hidden === false", { label: "rename dialog" });
await fillField("#group-name", "ลูกค้าใหม่");
const patchBefore = requestLog().filter((entry) => entry.method === "PATCH" && entry.path === `/api/groups/${G1}`).length;
await cdp.click("#group-save");
await cdp.waitFor(`__t.section(${JSON.stringify(G1)}).name === "ลูกค้าใหม่"`, { label: "section renamed" });
const groupPatch = requestLog().filter((entry) => entry.method === "PATCH" && entry.path === `/api/groups/${G1}`).slice(patchBefore);
check("rename group: PATCH carries the new name", groupPatch.length === 1 && groupPatch[0].body.name === "ลูกค้าใหม่", JSON.stringify(groupPatch[0] && groupPatch[0].body));
check("rename group: the section heading and chip follow", (await cdp.evaluate(`__t.chips().find((chip) => chip.key === ${JSON.stringify(G1)}).label`)).includes("ลูกค้าใหม่"));
check(
  "rename group: single-group card labels follow the new name",
  (await cdp.evaluate(`__t.one(${JSON.stringify(SEEDS[1].id)}, ${JSON.stringify(G1)}).label`)) === "ลูกค้าใหม่",
  await cdp.evaluate(`__t.one(${JSON.stringify(SEEDS[1].id)}, ${JSON.stringify(G1)}).label`),
);

/* duplicate name: 409 shows the note and keeps the dialog open */
await cdp.click(`${sectionSel(G2)} [data-act="group-rename"]`);
await cdp.waitFor("__t.modal('group-modal').hidden === false", { label: "second rename dialog" });
await fillField("#group-name", "ลูกค้าใหม่");
await cdp.click("#group-save");
await cdp.waitFor("__t.note('group-note').hidden === false", { label: "duplicate note" });
check("duplicate name: the 409 is reported inside the dialog", (await cdp.evaluate("__t.note('group-note').text")).includes("มีชื่อหมวดนี้อยู่แล้ว"));
check("duplicate name: the dialog stays open for a correction", (await cdp.evaluate("__t.modal('group-modal').hidden")) === false);
await cdp.click("#group-cancel");
await cdp.waitFor("__t.modal('group-modal').hidden === true", { label: "dialog closed" });

/* ------------------------------------------- older servers, one shape at a time */
const caseTail = (label) => `reload (${label})`;
stub.state.mode = "legacy";
await cdp.reload();
await cdp.waitFor(`typeof __t === "object" && __t.keys().length === 3`, { label: caseTail("legacy") });
await until(async () => (await cdp.evaluate(`__t.copies(${JSON.stringify(SEEDS[0].id)}).length`)) === 1, "legacy single membership");
check(
  "legacy server: groupId only still paints one section per board",
  (await cdp.evaluate(`__t.copies(${JSON.stringify(SEEDS[0].id)}).length`)) === 1 &&
    (await cdp.evaluate(`__t.one(${JSON.stringify(SEEDS[0].id)}, ${JSON.stringify(G1)}).label`)) === "ลูกค้าใหม่",
);
check("legacy server: a no-group board still lands in ไม่มีหมวดหมู่", (await cdp.evaluate(`__t.one(${JSON.stringify(SEEDS[2].id)}, "__none__").label`)) === "ไม่มีหมวด");

stub.state.mode = "none";
await cdp.reload();
await cdp.waitFor(`typeof __t === "object" && __t.keys().length === 3`, { label: caseTail("none") });
await until(async () => (await cdp.evaluate(`__t.copies(${JSON.stringify(SEEDS[0].id)}).length`)) === 2, "meta fallback restores both groups");
check("no inline membership: the per-card meta fallback still fills both sections", (await cdp.evaluate(`__t.copies(${JSON.stringify(SEEDS[0].id)}).map((copy) => copy.section).sort().join()`)) === [G1, G2].sort().join());
check("no inline membership: labels and counts survive the fallback", (await cdp.evaluate(`__t.copies(${JSON.stringify(SEEDS[0].id)})[0].label`)) === "2 หมวด");

stub.state.mode = "inline";
stub.state.groupsDisabled = true;
await cdp.reload();
await cdp.waitFor(`typeof __t === "object" && document.getElementById('groupbar').hidden === true`, { label: caseTail("no groups api") });
check("no /api/groups: the page falls back to the flat grid", (await cdp.evaluate("__t.keys().length")) === 0 && (await cdp.evaluate("document.querySelectorAll('#grid > .card').length")) === 3);
check("no /api/groups: the per-card control is hidden, not broken", (await cdp.evaluate("Array.prototype.every.call(document.querySelectorAll('.group-pick'), (pick) => pick.hidden)")) === true);
stub.state.groupsDisabled = false;
await cdp.reload();
await cdp.waitFor("typeof __t === 'object' && __t.keys().length === 3", { label: caseTail("groups back") });
await until(async () => (await cdp.evaluate(`__t.copies(${JSON.stringify(SEEDS[0].id)}).length`)) === 2, "sections back");

/* --------------------------------------------------------------- 393 px */
await cdp.viewport(393, 852);
await cdp.reload();
await cdp.waitFor("typeof __t === 'object' && __t.keys().length === 3", { label: "mobile sections" });
await until(async () => (await cdp.evaluate(`__t.copies(${JSON.stringify(SEEDS[0].id)}).length`)) === 2, "mobile membership");
await closeMenus();
await openMenuAt(G2, SEEDS[0].id);
const mobileBox = await cdp.evaluate(`__t.menuBox(${JSON.stringify(SEEDS[0].id)})`);
check(
  "393px: the menu opens inside its card",
  mobileBox && mobileBox.menu.left >= mobileBox.card.left - 1 && mobileBox.menu.right <= mobileBox.card.right + 1 && mobileBox.menu.bottom <= mobileBox.card.bottom + 1 && mobileBox.menu.width > 100,
  mobileBox ? `menu ${Math.round(mobileBox.menu.left)}..${Math.round(mobileBox.menu.right)} / card ${Math.round(mobileBox.card.left)}..${Math.round(mobileBox.card.right)}` : "no box",
);
const mobileOverflow = await cdp.evaluate("__t.overflow()");
check("393px: the page does not scroll sideways", mobileOverflow.scrollWidth === mobileOverflow.clientWidth, JSON.stringify(mobileOverflow));
const tap = await cdp.evaluate(
  `(() => { const r = document.querySelector('${triggerSel(G2, SEEDS[0].id)}').getBoundingClientRect(); return { w: r.width, h: r.height }; })()`,
);
check("393px: the trigger is still there, full-width and tappable", tap.w > 120 && tap.h >= 24, JSON.stringify(tap));
await cdp.quiet();
const mobileLightShot = await cdp.screenshot(path.join(OUT, "mobile-light.png"));
check("393px: screenshot captured", existsSync(mobileLightShot), mobileLightShot);

/* ------------------------------------------------------------------ theme */
await cdp.viewport(1440, 900);
await cdp.mediaScheme("light");
await cdp.evaluate("localStorage.removeItem('boards-theme')");
await cdp.reload();
await cdp.waitFor("typeof __t === 'object' && __t.keys().length === 3", { label: "theme baseline" });
await cdp.quiet();
const lightShot = await cdp.screenshot(path.join(OUT, "light.png"));
const lightLum = meanLuminance(decodePng(await readFile(lightShot)), { x: 0, y: 220, width: 70, height: 120 });
check("theme: a fresh visitor gets the light palette", (await cdp.evaluate("__t.theme().attr")) === "light" && lightLum > 0.5, `lum ${lightLum.toFixed(2)}`);
check("theme: the toggle shows the moon before switching", (await cdp.evaluate("__t.theme().glyph")) === "☾");
await cdp.click("#theme-toggle");
await cdp.waitFor("__t.theme().attr === 'dark'", { label: "dark applied" });
const darkTheme = await cdp.evaluate("__t.theme()");
check("theme: clicking stores the choice", darkTheme.stored === "dark" && darkTheme.glyph === "☀", JSON.stringify(darkTheme));
await cdp.quiet();
const darkShot = await cdp.screenshot(path.join(OUT, "dark.png"));
const darkLum = meanLuminance(decodePng(await readFile(darkShot)), { x: 0, y: 220, width: 70, height: 120 });
check("theme: the dark palette really paints darker", darkLum < 0.2 && lightLum - darkLum > 0.4, `light ${lightLum.toFixed(2)} dark ${darkLum.toFixed(2)}`);
await cdp.reload();
await cdp.waitFor("typeof __t === 'object' && __t.keys().length === 3", { label: "reload with stored dark" });
check("theme: the stored choice survives a reload", (await cdp.evaluate("__t.theme().attr")) === "dark");
check("theme: the no-flash head script applies it before css", (await cdp.evaluate("document.documentElement.getAttribute('data-theme')")) === "dark");
await cdp.mediaScheme("dark");
await cdp.evaluate("localStorage.removeItem('boards-theme')");
await cdp.reload();
await cdp.waitFor("typeof __t === 'object' && __t.keys().length === 3", { label: "os dark" });
check("theme: with no stored choice the OS preference wins", (await cdp.evaluate("__t.theme().attr")) === "dark");
await cdp.quiet();
const mobileDarkShot = await cdp.screenshot(path.join(OUT, "mobile-dark.png"));
check("theme: a dark screenshot was kept for review", existsSync(mobileDarkShot), mobileDarkShot);
await cdp.mediaScheme("light");
await cdp.evaluate("localStorage.removeItem('boards-theme')");
await cdp.reload();
await cdp.waitFor("typeof __t === 'object' && __t.keys().length === 3", { label: "os light" });
check("theme: going back to a light OS preference paints light again", (await cdp.evaluate("__t.theme().attr")) === "light");

/* ---------------------------------------------- rename and delete a board */
await cdp.click(`${cardSel(G1, SEEDS[0].id)} .rename`);
await cdp.waitFor("__t.modal('rename-modal').hidden === false", { label: "rename dialog" });
await fillField("#rename-input", "ชื่อใหม่ Alpha");
await cdp.click("#rename-save");
await cdp.waitFor(`__t.text('${cardSel(G1, SEEDS[0].id)} h2') === "ชื่อใหม่ Alpha"`, { label: "title renamed" });
check(
  "rename board: every copy of the card shows the new title",
  (await cdp.evaluate(
    `(() => Array.prototype.every.call(document.querySelectorAll('.card[data-slug="${SEEDS[0].id}"] h2'), (h2) => h2.textContent === "ชื่อใหม่ Alpha"))()`,
  )) === true,
);
check("rename board: the server holds the new title", stub.state.boards.get(SEEDS[0].id).title === "ชื่อใหม่ Alpha");

const deleteVisible = await cdp.evaluate(`document.querySelectorAll('.card[data-slug="${SEEDS[2].id}"]').length`);
await cdp.click(`${cardSel("__none__", SEEDS[2].id)} .del`);
await cdp.waitFor("__t.modal('del-modal').hidden === false", { label: "delete dialog" });
check("delete board: the dialog names the file that will go", (await cdp.evaluate("__t.text('#del-detail')")).includes(`${SEEDS[2].id}.excalidraw`), await cdp.evaluate("__t.text('#del-detail')"));
await cdp.hold("#del-hold", 1400);
await cdp.waitFor(`document.querySelectorAll('.card[data-slug="${SEEDS[2].id}"]').length === 0`, { label: "board card removed" });
check(
  "delete board: the board disappears from the grid and the API",
  (await cdp.evaluate("document.querySelectorAll('#sections .card').length")) === 3 && !stub.state.boards.has(SEEDS[2].id),
  `${deleteVisible} copies before, 3 cards left (alpha twice, beta once)`,
);
check("delete board: the counter drops to the remaining boards", (await cdp.evaluate("__t.text('#count')")) === "2 กระดาน", await cdp.evaluate("__t.text('#count')"));

/* -------------------------------------------------------- console hygiene */
const jsErrors = cdp.consoleErrors.filter((line) =>
  /Uncaught|TypeError|ReferenceError|SyntaxError|is not a function|Cannot read|Unhandled/.test(line),
);
check("console: no uncaught javascript errors during the whole run", jsErrors.length === 0, jsErrors.slice(0, 4).join(" | "));

/* the stub answers 404 on purpose during the revert test — that is a network
   log line, not a page error, so it must be the only other thing in the log */
const otherErrors = cdp.consoleErrors.filter(
  (line) => !/Failed to load resource|favicon/.test(line) && !jsErrors.includes(line),
);
check("console: the only other entries are the deliberate 404s", otherErrors.length === 0, otherErrors.slice(0, 3).join(" | "));
  } finally {
    chrome.kill();
    /* chrome keeps keep-alive sockets on the stub; close them or close() never calls back */
    if (typeof stub.server.closeAllConnections === "function") stub.server.closeAllConnections();
    await Promise.race([
      new Promise((resolve) => stub.server.close(resolve)),
      sleep(3000),
    ]);
  }

  const passed = results.filter((result) => result.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  if (failures) {
    console.log(`\n${failures} failed:`);
    for (const result of results) {
      if (!result.ok) console.log(`  · ${result.name}${result.detail ? ` — ${result.detail}` : ""}`);
    }
  }
  console.log(`screenshots: ${OUT}`);
  if (failures) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\nharness error: ${error && error.stack ? error.stack : error}`);
  process.exitCode = 1;
});
