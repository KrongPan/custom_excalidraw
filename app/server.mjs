#!/usr/bin/env node
/**
 * server.mjs — boards server for the self-hosted Excalidraw app.
 *
 * Zero dependencies (node:http + node:fs). Serves three things from one origin:
 *   /gallery/…   the generated board catalogue (gallery/site)
 *   /scenes/…    raw scene files (download / #url= deep link)
 *   /, /b/:id    the editor SPA (app/dist), which talks to /api/boards
 *
 * Boards are plain files on the host disk — that is the whole point: nothing
 * lives in the browser anymore. Every board is one folder:
 *
 *   DATA_DIR/<id>/scene.excalidraw           the scene the editor reads/writes
 *   DATA_DIR/<id>/meta.json                  optional title/subtitle/tags
 *   DATA_DIR/<id>/history/<stamp>.excalidraw snapshots, pruned oldest first
 *
 *   DATA_DIR     board folders             (default ./gallery/scenes)
 *   APP_DIR      built SPA                 (default ./app/dist)
 *   GALLERY_DIR  built catalogue           (default ./gallery/site)
 *   GALLERY_BUILD path to gallery/build.mjs; when set, the catalogue is
 *                rewritten after every board write/rename/delete (default off)
 *   PORT         listen port               (default 5002)
 *   HISTORY_KEEP snapshots kept per board  (default 100)
 *   BUILD_COMMIT build stamp shown by /api/health (default "dev")
 *   BUILD_DATE   build stamp shown by /api/health (default "dev")
 *
 * The old flat layout (`<id>.excalidraw`, `<id>.meta.json`,
 * `.history/<id>/`) is still listed and opened: the first write moves the
 * board into its folder (see migrateLegacy below), and scripts/migrate-scenes.mjs
 * does the same for every board in one go.
 */

import { createServer } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants as zlib, gzip } from "node:zlib";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 5002);
const DATA_DIR = resolve(process.env.DATA_DIR || "./gallery/scenes");
const APP_DIR = resolve(process.env.APP_DIR || "./app/dist");
const GALLERY_DIR = resolve(process.env.GALLERY_DIR || "./gallery/site");
const GALLERY_BUILD = process.env.GALLERY_BUILD ? resolve(process.env.GALLERY_BUILD) : "";
/* 100 snapshots is the shipped default; an operator can lower or raise it. */
const HISTORY_KEEP = (() => {
  const raw = Number(process.env.HISTORY_KEEP);
  return Number.isInteger(raw) && raw >= 0 ? raw : 100;
})();
const MAX_BODY = 32 * 1024 * 1024;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const SCENE_RE = /\.excalidraw$/i;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".excalidraw": "application/json; charset=utf-8",
};
const typeOf = (p) => TYPES[extname(p).toLowerCase()] || "application/octet-stream";

/*
 * Compression is for text the browser will parse again anyway. PNG, JPEG and
 * woff2 are already packed containers: running them through brotli costs CPU
 * and saves nothing. `.excalidraw` is JSON, so a scene download does benefit.
 */
const COMPRESSIBLE = new Set([".html", ".js", ".mjs", ".css", ".json", ".map", ".svg", ".txt", ".excalidraw"]);
/* Below this the framing overhead eats the win; above it a scene is too big to buffer. */
const COMPRESS_MIN = 1024;
const COMPRESS_MAX = 8 * 1024 * 1024;
const COMPRESS_CACHE_MAX = 64 * 1024 * 1024;
/* The image is stamped at build time so /api/health can tell which build answered. */
const BUILD = { commit: process.env.BUILD_COMMIT || "dev", date: process.env.BUILD_DATE || "dev" };

const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ------------------------------------------------------------------ helpers */

function send(res, code, body, headers = {}) {
  res.writeHead(code, { "X-Content-Type-Options": "nosniff", ...headers });
  res.end(body);
}
const json = (res, code, value) =>
  send(res, code, JSON.stringify(value), { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
const fail = (res, code, message, extra = {}) => json(res, code, { error: message, ...extra });

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Reject any path that escapes `root` (path traversal guard). */
function within(root, relPath) {
  const target = resolve(root, "." + (relPath.startsWith("/") ? relPath : `/${relPath}`));
  return target === root || target.startsWith(root + sep) ? target : null;
}

/* ------------------------------------------------------------ file responses */

const brotli = promisify(brotliCompress);
const gzipped = promisify(gzip);
/* "<path>|<mtime>|<encoding>" -> Buffer. The SPA entry is 1.4MB and every visit
 * asks for it, so the work must happen once per file version, not per request. */
const compressed = new Map();
let compressedBytes = 0;

function rememberCompressed(key, body) {
  compressed.delete(key); // re-insert so the eviction order stays least-recent
  compressed.set(key, body);
  compressedBytes += body.length;
  for (const k of compressed.keys()) {
    if (compressedBytes <= COMPRESS_CACHE_MAX) break;
    compressedBytes -= compressed.get(k).length;
    compressed.delete(k);
  }
}

/** "br" when the client takes it (≈20% smaller than gzip), else "gzip", else null. */
function preferredEncoding(req) {
  const header = String(req?.headers?.["accept-encoding"] || "").toLowerCase();
  if (!header) return null;
  const q = new Map();
  for (const part of header.split(",")) {
    const [rawName, ...params] = part.trim().split(";");
    if (!rawName) continue;
    const weight = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    q.set(rawName.trim(), weight ? Number(weight.slice(2)) || 0 : 1);
  }
  // highest weight wins; brotli wins a tie because it is the smaller encoding
  let best = null;
  let bestWeight = 0;
  for (const encoding of ["br", "gzip"]) {
    const weight = q.has(encoding) ? q.get(encoding) : (q.get("*") ?? 0);
    if (weight > bestWeight) {
      best = encoding;
      bestWeight = weight;
    }
  }
  return best;
}

async function compressBody(encoding, body, size) {
  if (encoding === "br") {
    return brotli(body, { params: { [zlib.BROTLI_PARAM_QUALITY]: 5, [zlib.BROTLI_PARAM_SIZE_HINT]: size } });
  }
  return gzipped(body, { level: 6 });
}

/**
 * The wire form of one file: a build-time `.br`/`.gz` written next to it
 * (`server.mjs --precompress`), else a compressed copy kept in memory, else the
 * file itself. A sidecar older than its source is ignored — it would be stale.
 */
async function wireForm(req, filePath, info) {
  const ext = extname(filePath).toLowerCase();
  if (!COMPRESSIBLE.has(ext) || info.size < COMPRESS_MIN || info.size > COMPRESS_MAX) return { encoding: null };
  const encoding = preferredEncoding(req);
  if (!encoding) return { encoding: null };
  const key = `${filePath}|${Math.round(info.mtimeMs)}|${encoding}`;
  const cached = compressed.get(key);
  if (cached) return { encoding, body: cached };

  const sidecar = `${filePath}${encoding === "br" ? ".br" : ".gz"}`;
  const sidecarInfo = await stat(sidecar).catch(() => null);
  if (sidecarInfo?.isFile() && sidecarInfo.mtimeMs >= info.mtimeMs && sidecarInfo.size < info.size) {
    const body = await readFile(sidecar);
    rememberCompressed(key, body);
    return { encoding, body };
  }

  const body = await compressBody(encoding, await readFile(filePath), info.size);
  if (body.length >= info.size) return { encoding: null }; // already dense: send it raw
  rememberCompressed(key, body);
  return { encoding, body };
}

/** Weak validator: the same bytes compressed and uncompressed are one entity. */
const etagOf = (info) => `W/"${Math.round(info.mtimeMs).toString(36)}-${info.size.toString(36)}"`;

function matchesEtag(header, etag) {
  if (!header) return false;
  const bare = etag.replace(/^W\//, "");
  return String(header)
    .split(",")
    .some((part) => {
      const tag = part.trim();
      return tag === "*" || tag.replace(/^W\//, "") === bare;
    });
}

async function serveFile(req, res, filePath, { cache = "no-cache", download = null, status = 200, revalidate = true } = {}) {
  let info;
  try {
    info = await stat(filePath);
  } catch {
    return false;
  }
  if (!info.isFile()) return false;

  const headers = {
    "Content-Type": typeOf(filePath),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": cache,
    ...(download ? { "Content-Disposition": `attachment; filename="${download}"` } : {}),
    // the body varies by encoding even when the URL does not
    ...(COMPRESSIBLE.has(extname(filePath).toLowerCase()) ? { Vary: "Accept-Encoding" } : {}),
  };

  // Hashed /assets/* never revalidate; everything else answers a repeat visit
  // with 304 instead of re-sending the whole catalogue, thumbnail or font.
  if (revalidate) {
    const etag = etagOf(info);
    headers.ETag = etag;
    headers["Last-Modified"] = new Date(info.mtimeMs).toUTCString();
    if (matchesEtag(req?.headers?.["if-none-match"], etag)) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }
  }

  const wire = await wireForm(req, filePath, info);
  if (wire.encoding) {
    headers["Content-Encoding"] = wire.encoding;
    headers["Content-Length"] = wire.body.length;
    res.writeHead(status, headers);
    res.end(wire.body);
    return true;
  }

  headers["Content-Length"] = info.size;
  res.writeHead(status, headers);
  await new Promise((ok, no) => {
    const s = createReadStream(filePath);
    s.on("error", no);
    s.on("end", ok);
    s.pipe(res);
  }).catch(() => {});
  return true;
}

async function fileExists(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function notFoundPage(pathname) {
  const safe = String(pathname).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]);
  return `<!doctype html><html lang="th"><meta charset="utf-8"><title>ไม่พบหน้านี้ · Excalidraw boards</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#121212;color:#e8e8ea;font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{text-align:center;padding:40px}h1{font-size:22px;margin:0 0 8px}p{color:#9a9aa2;margin:0 0 22px}
code{background:#1e1e24;padding:2px 6px;border-radius:5px;color:#c9c9d1}
a{display:inline-block;background:#4a5bd6;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600}</style>
<main><h1>ไม่พบหน้านี้</h1><p><code>${safe}</code> ไม่มีอยู่ในเซิร์ฟเวอร์นี้</p><a href="/">กลับไปหน้าแกลเลอรี</a></main></html>`;
}

/* ----------------------------------------------------------------- storage */

/*
 * Every board is one folder and every path below is derived here — no route or
 * handler joins DATA_DIR by hand, so the layout can change in one place.
 *
 *   <DATA_DIR>/<id>/scene.excalidraw
 *   <DATA_DIR>/<id>/meta.json
 *   <DATA_DIR>/<id>/history/<ISO stamp>.excalidraw
 *
 * Legacy (pre-folder) boards keep working: they are read from the flat paths
 * until their first write, which calls migrateLegacy() and moves the scene,
 * the sidecar and the old `.history/<id>/` snapshots into the folder.
 */
const boardDir = (id) => join(DATA_DIR, id);
const scenePath = (id) => join(boardDir(id), "scene.excalidraw");
const metaPath = (id) => join(boardDir(id), "meta.json");
const historyDir = (id) => join(boardDir(id), "history");

const legacyScenePath = (id) => join(DATA_DIR, `${id}.excalidraw`);
const legacyMetaPath = (id) => join(DATA_DIR, `${id}.meta.json`);
const legacyHistoryDir = (id) => join(DATA_DIR, ".history", id);

async function dirExists(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** The scene file this board currently lives in (folder first, then legacy). */
async function sceneFile(id) {
  const current = scenePath(id);
  if (await fileExists(current)) return current;
  const legacy = legacyScenePath(id);
  if (await fileExists(legacy)) return legacy;
  return null;
}

const boardExists = async (id) => (await sceneFile(id)) !== null;

/** Move one flat file into place; rename keeps mtime, copy+unlink is the fallback. */
async function moveInto(from, to) {
  try {
    await rename(from, to);
  } catch {
    await copyFile(from, to);
    await unlink(from).catch(() => {});
  }
}

/** Move `DATA_DIR/.history/<id>/` snapshots into `<id>/history/`. */
async function migrateLegacyHistory(id) {
  const from = legacyHistoryDir(id);
  let names;
  try {
    names = await readdir(from);
  } catch {
    return;
  }
  const snapshots = names.filter((name) => !name.startsWith(".") && SCENE_RE.test(name));
  if (!snapshots.length) {
    await rmdir(from).catch(() => {}); // only removes an empty directory
    return;
  }
  await mkdir(historyDir(id), { recursive: true });
  let failed = 0;
  for (const name of snapshots) {
    const target = join(historyDir(id), name);
    if (await fileExists(target)) continue; // the folder copy is the live one
    await moveInto(join(from, name), target).catch(() => {
      failed += 1;
    });
  }
  // anything that could not move stays where it is (ENOTEMPTY), so history is
  // never silently dropped
  if (!failed) await rmdir(from).catch(() => {});
  await rmdir(join(DATA_DIR, ".history")).catch(() => {});
}

/**
 * Move a legacy flat board into its folder, in place, before the first write.
 * Reads never call this: listing and opening a never-written board stays
 * side-effect free. Returns true when something was moved.
 */
async function migrateLegacy(id) {
  const hadScene = await fileExists(legacyScenePath(id));
  const hadMeta = await fileExists(legacyMetaPath(id));
  if (!hadScene && !hadMeta) {
    await migrateLegacyHistory(id);
    return false;
  }
  if (!hadScene) {
    // a stray sidecar without a scene belongs to no board: do not invent one
    return false;
  }
  await mkdir(boardDir(id), { recursive: true });
  if (await fileExists(scenePath(id))) {
    // a half-finished migration left both: the folder copy is authoritative
    await unlink(legacyScenePath(id)).catch(() => {});
  } else {
    await moveInto(legacyScenePath(id), scenePath(id));
  }
  if (hadMeta) {
    if (await fileExists(metaPath(id))) await unlink(legacyMetaPath(id)).catch(() => {});
    else await moveInto(legacyMetaPath(id), metaPath(id));
  }
  await migrateLegacyHistory(id);
  return true;
}

/** Snapshot files of a board, newest first, folder and legacy dirs merged. */
async function historyFiles(id) {
  const byName = new Map();
  for (const [dir, priority] of [
    [historyDir(id), 1],
    [legacyHistoryDir(id), 0],
  ]) {
    let names;
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith(".") || !SCENE_RE.test(name)) continue;
      const path = join(dir, name);
      const info = await stat(path).catch(() => null);
      if (!info?.isFile()) continue;
      const seen = byName.get(name);
      if (seen && seen.priority > priority) continue;
      byName.set(name, { name, path, priority, bytes: info.size, mtimeMs: info.mtimeMs });
    }
  }
  // newest first; ISO-ish stamp names break ties so the order is stable
  return [...byName.values()].sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
}

/** Keep only the newest HISTORY_KEEP snapshots; oldest go first. */
async function pruneHistory(id) {
  const files = await historyFiles(id);
  for (const old of files.slice(HISTORY_KEEP)) {
    await unlink(old.path).catch(() => {});
  }
}

/** `<ISO stamp>.excalidraw`, with a counter when two saves land in one ms. */
async function snapshotName(id) {
  const base = new Date().toISOString().replace(/[:.]/g, "-");
  let name = `${base}.excalidraw`;
  for (let i = 1; await fileExists(join(historyDir(id), name)); i += 1) {
    name = `${base}-${i}.excalidraw`;
  }
  return name;
}

function emptyScene() {
  return {
    type: "excalidraw",
    version: 2,
    source: "boards-server",
    elements: [],
    appState: { gridSize: 20, gridStep: 5, gridModeEnabled: false, viewBackgroundColor: "#ffffff" },
    files: {},
  };
}

function slugify(name) {
  const base = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60);
  return base || "board";
}

async function uniqueId(wanted) {
  const base = slugify(wanted);
  for (let i = 0; i < 500; i += 1) {
    const id = i === 0 ? base : `${base}-${i + 1}`;
    if (!(await boardExists(id))) return id;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/** Keep the previous copy of a board before overwriting it. */
async function snapshot(id) {
  try {
    const source = await sceneFile(id);
    if (!source) return;
    const info = await stat(source);
    if (info.size === 0) return;
    await mkdir(historyDir(id), { recursive: true });
    await copyFile(source, join(historyDir(id), await snapshotName(id)));
    await pruneHistory(id);
  } catch {
    /* first save: nothing to snapshot */
  }
}

/*
 * A writer that dies between writeFile and rename leaves `<scene>.tmp-<pid>-…`
 * behind and nothing will ever finish it: those cost megabytes per crash in the
 * live data dir. Only that exact prefix is swept, and only once it is surely
 * abandoned — ten minutes is far longer than any write here takes.
 */
const TMP_PREFIX = "scene.excalidraw.tmp-";
const TMP_MAX_AGE_MS = 10 * 60 * 1000;

async function sweepSceneTemps(dir, now = Date.now()) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return 0; // not a board folder
  }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(TMP_PREFIX)) continue;
    const file = join(dir, name);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile() || now - info.mtimeMs < TMP_MAX_AGE_MS) continue;
    await unlink(file).catch(() => {});
    removed += 1;
  }
  return removed;
}

/** Sweep every board folder; runs once at boot, before the first request. */
async function sweepAllSceneTemps(now = Date.now()) {
  let names;
  try {
    names = await readdir(DATA_DIR);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (name.startsWith(".")) continue;
    removed += await sweepSceneTemps(join(DATA_DIR, name), now);
  }
  if (removed) log(`swept ${removed} abandoned scene temp file(s)`);
  return removed;
}

async function writeAtomic(path, contents) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`;
  await writeFile(tmp, contents);
  await rename(tmp, path);
}

/** Write a board: keep the old copy, then atomically replace the file. */
async function saveScene(id, scene) {
  await mkdir(DATA_DIR, { recursive: true });
  await migrateLegacy(id); // a legacy flat board moves into its folder on the first write
  await snapshot(id);
  await mkdir(boardDir(id), { recursive: true });
  await sweepSceneTemps(boardDir(id)); // leftovers of a crashed writer, before adding another
  await writeAtomic(scenePath(id), `${JSON.stringify(scene, null, 2)}\n`);
}

/** Serialise writes per board: two editors saving at once must not interleave. */
const boardLocks = new Map();
function withBoardLock(id, fn) {
  const prev = boardLocks.get(id) || Promise.resolve();
  const next = prev.then(fn, fn);
  boardLocks.set(
    id,
    next.catch(() => {}),
  );
  return next;
}

/* --------------------------------------------------------------------- meta */

/*
 * `gallery/scenes/<id>/meta.json` is an optional sidecar:
 * { title, subtitle, tags, groupIds, groupId }. It holds the board's display
 * name and the หมวดหมู่ it is filed under while the scene file stays a pure
 * Excalidraw document. A board can sit in several groups at once: `groupIds`
 * is the list, `groupId` is kept in sync as its first entry (null when empty)
 * so older code and hand-edits still see something sane.
 * Missing, empty or broken sidecars all read as "no metadata".
 * A legacy `<id>.meta.json` next to the flat scene is read until the board is
 * migrated into its folder.
 */

const META_TITLE_MAX = 120;
const META_GROUPS_MAX = 20;

async function readMeta(id) {
  for (const file of [metaPath(id), legacyMetaPath(id)]) {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      /* try the next location */
    }
  }
  return {};
}

/**
 * The membership of one board as a list. `groupIds` is the stored form; the old
 * single `groupId` is still honoured for hand-written sidecars. Duplicates
 * collapse (first occurrence wins) and, when a live group set is given, ids
 * that no longer exist in `.groups.json` disappear on read — they are never
 * written back by the next patch.
 */
const isGroupId = (value) => typeof value === "string" && value.length > 0;

function groupIdsOf(meta, live = null) {
  const raw = Array.isArray(meta?.groupIds)
    ? meta.groupIds.filter(isGroupId)
    : isGroupId(meta?.groupId)
      ? [meta.groupId]
      : [];
  const seen = new Set();
  const out = [];
  for (const id of raw) {
    if (seen.has(id) || (live && !live.has(id))) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** The ids `.groups.json` currently holds; membership is filtered against it. */
async function liveGroupIds() {
  const { groups } = await readGroupStore();
  return new Set(groups.map((group) => group.id));
}

/**
 * Public shape: the title always exists (falls back to the board id) and
 * `groupId` is always the first membership, so one field keeps working for
 * older clients. `groupIds` rides along whenever the board belongs to
 * something (and always on a membership write, so a clear echoes `[]`).
 */
function metaView(id, meta, { groupIds = groupIdsOf(meta), always = false } = {}) {
  const view = {
    id,
    title: typeof meta?.title === "string" && meta.title ? meta.title : id,
    subtitle: typeof meta?.subtitle === "string" ? meta.subtitle : "",
    tags: Array.isArray(meta?.tags) ? meta.tags.map(String) : [],
    groupId: groupIds[0] || null,
  };
  if (groupIds.length || always) view.groupIds = groupIds;
  return view;
}

async function apiMetaGet(res, id) {
  if (!(await boardExists(id))) return fail(res, 404, `board not found: ${id}`);
  const meta = await readMeta(id);
  json(res, 200, metaView(id, meta, { groupIds: groupIdsOf(meta, await liveGroupIds()), always: true }));
}

async function apiMetaPatch(res, req, id) {
  if (!(await boardExists(id))) return fail(res, 404, `board not found: ${id}`);

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return fail(res, 400, "body is not valid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return fail(res, 400, "expected a JSON object");
  }

  // one endpoint, independent keys: a rename does not touch the groups and a
  // membership write does not rename (unknown keys stay ignored, as before)
  const hasTitle = "title" in body;
  const hasGroupIds = "groupIds" in body;
  const hasGroupId = "groupId" in body;
  const hasMembership = hasGroupIds || hasGroupId;
  if (hasGroupIds && hasGroupId) return fail(res, 400, "send either groupIds or groupId");
  if (!hasTitle && !hasMembership) return fail(res, 400, 'expected "title" or "groupIds"/"groupId" to be set');

  let title = "";
  if (hasTitle) {
    if (typeof body.title !== "string") return fail(res, 400, 'expected "title" to be a string');
    title = body.title.trim();
    if ([...title].length > META_TITLE_MAX) {
      return fail(res, 400, `title is longer than ${META_TITLE_MAX} characters`);
    }
  }

  // groupIds: the complete list — [] ungroups, insertion order is kept and a
  // repeated id collapses onto its first slot. Members are only checked for
  // existence further down, under the group lock: "grp_nope" is an unknown id
  // (404), not a malformed one (400), which is what the UI toasts.
  let wantedIds; // undefined = untouched, [] = ungrouped, [id, …] = exactly that
  if (hasGroupIds) {
    if (!Array.isArray(body.groupIds) || body.groupIds.some((id) => typeof id !== "string")) {
      return fail(res, 400, 'expected "groupIds" to be an array of strings');
    }
    if (body.groupIds.length > META_GROUPS_MAX) {
      return fail(res, 400, `"groupIds" holds more than ${META_GROUPS_MAX} ids`);
    }
    const ids = [];
    for (const raw of body.groupIds) {
      const wanted = raw.trim();
      if (!wanted) return fail(res, 400, 'expected "groupIds" to be an array of strings');
      if (!ids.includes(wanted)) ids.push(wanted);
    }
    wantedIds = ids;
  } else if (hasGroupId) {
    // the old single-id shape still works: it replaces the whole list with one
    // id (or clears it), it never appends to what the board already has
    if (body.groupId === null) {
      wantedIds = [];
    } else if (typeof body.groupId === "string") {
      const wanted = body.groupId.trim();
      if (!wanted) wantedIds = [];
      else if (!GROUP_ID_RE.test(wanted)) return fail(res, 400, "invalid group id");
      else wantedIds = [wanted];
    } else {
      return fail(res, 400, 'expected "groupId" to be a string or null');
    }
  }

  // read-modify-write under the board lock so a rename cannot race a scene save;
  // a membership write additionally takes the group lock so a group cannot be
  // deleted between the existence check and the sidecar write. Groups → board is
  // the same order apiGroupDelete uses, so the two can never deadlock.
  const apply = () =>
    withBoardLock(id, async () => {
      const { groups } = await readGroupStore();
      const live = new Set(groups.map((group) => group.id));
      await migrateLegacy(id); // a rename is a write: the board joins its folder too
      const current = await readMeta(id);
      // an unrelated patch keeps the board where it is, but ids whose group is
      // gone are filtered out here — a stale id is never written back
      const nextIds = wantedIds ?? groupIdsOf(current, live);
      for (const wanted of nextIds) {
        if (!live.has(wanted)) return { missing: wanted };
      }

      const next = {};
      const nextTitle = hasTitle ? title : typeof current.title === "string" ? current.title : "";
      if (nextTitle) next.title = nextTitle;
      if (typeof current.subtitle === "string" && current.subtitle) next.subtitle = current.subtitle;
      if (Array.isArray(current.tags) && current.tags.length) next.tags = current.tags;
      // both keys are written together so old code and hand-edits agree;
      // `groupId` mirrors the first membership and null means "no group". A
      // title-only patch on an ungrouped board keeps its old sidecar shape.
      if (nextIds.length) {
        next.groupIds = nextIds;
        next.groupId = nextIds[0];
      } else if (hasMembership) {
        next.groupIds = [];
        next.groupId = null;
      }

      // nothing custom left: the sidecar goes away instead of holding `{}`
      const empty = !next.title && !next.subtitle && !next.tags && !nextIds.length;
      if (!empty) {
        await mkdir(boardDir(id), { recursive: true });
        await writeAtomic(metaPath(id), `${JSON.stringify(next, null, 2)}\n`);
      } else {
        await unlink(metaPath(id)).catch(() => {});
        await unlink(legacyMetaPath(id)).catch(() => {});
      }
      return { meta: next, groupIds: nextIds };
    });

  const outcome = hasMembership ? await withGroupsLock(apply) : await apply();
  if (outcome?.missing !== undefined) return fail(res, 404, `group not found: ${outcome.missing}`);

  const view = metaView(id, outcome.meta, { groupIds: outcome.groupIds, always: true });
  broadcast(id, { type: "meta", ...view });
  log("meta", id, view.title);
  scheduleGalleryRebuild();
  json(res, 200, view);
}

/* ------------------------------------------------------------------- groups */

/*
 * `DATA_DIR/.groups.json` is the one file behind the board categories
 * ("หมวดหมู่"): a plain JSON document, hand-editable like the board folders.
 *
 *   { "version": 1, "groups": [ { id, name, color, createdAt, updatedAt } ] }
 *
 * The file is optional — no file (or a broken one) simply means zero groups and
 * is never created by a read. Boards point at their groups through their own
 * meta.json (`groupIds`, with `groupId` kept as the first entry), so membership
 * lives with the board and this file only holds the taxonomy. Deleting a group
 * rewrites those sidecars to drop just that id.
 */
const GROUPS_FILE = join(DATA_DIR, ".groups.json");
const GROUPS_VERSION = 1;
const GROUP_COLORS = ["violet", "blue", "teal", "amber", "rose", "slate"];
const GROUP_NAME_MAX = 40;
const GROUP_ID_RE = /^grp_[0-9a-f]{8}$/;

/* Every group write is a read-modify-write of the same file, so they share one
 * queue: the per-board lock under a key no board id can ever equal (board ids
 * must start with an alphanumeric character, ID_RE). */
const GROUPS_LOCK = "::groups";
const withGroupsLock = (fn) => withBoardLock(GROUPS_LOCK, fn);

/** One stored group, normalised; null when the record is unusable. */
function groupRecord(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!GROUP_ID_RE.test(id) || !name) return null;
  const now = new Date().toISOString();
  return {
    id,
    name,
    color: GROUP_COLORS.includes(raw.color) ? raw.color : "violet",
    createdAt: typeof raw.createdAt === "string" && raw.createdAt ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === "string" && raw.updatedAt ? raw.updatedAt : now,
  };
}

/** The group store; a missing or unreadable file reads as zero groups. */
async function readGroupStore() {
  let raw;
  try {
    raw = await readFile(GROUPS_FILE, "utf8");
  } catch {
    return { version: GROUPS_VERSION, groups: [] }; // no file yet: nothing to list
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    log("groups file is not valid JSON, treating it as empty:", error?.message);
    return { version: GROUPS_VERSION, groups: [] };
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.groups)) {
    log("groups file has no groups array, treating it as empty");
    return { version: GROUPS_VERSION, groups: [] };
  }
  const seen = new Set();
  const groups = [];
  for (const entry of parsed.groups) {
    const record = groupRecord(entry);
    if (!record || seen.has(record.id)) continue;
    seen.add(record.id);
    groups.push(record);
  }
  return { version: GROUPS_VERSION, groups };
}

async function writeGroupStore(groups) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeAtomic(GROUPS_FILE, `${JSON.stringify({ version: GROUPS_VERSION, groups }, null, 2)}\n`);
}

const sameGroupName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * How many boards include each group — one disk scan for the whole list. A
 * board filed under two groups counts once in each of them.
 */
async function groupCounts() {
  const counts = new Map();
  const live = await liveGroupIds();
  for (const [id] of await listBoards()) {
    for (const groupId of groupIdsOf(await readMeta(id), live)) {
      counts.set(groupId, (counts.get(groupId) || 0) + 1);
    }
  }
  return counts;
}

/** Public shape of a group; `count` is added by the list endpoint only. */
const groupView = ({ id, name, color, createdAt, updatedAt }) => ({ id, name, color, createdAt, updatedAt });

/** `grp_` + 8 hex chars, never colliding with an existing group. */
async function newGroupId(groups) {
  const taken = new Set(groups.map((group) => group.id));
  for (let i = 0; i < 500; i += 1) {
    const id = `grp_${randomBytes(4).toString("hex")}`;
    if (!taken.has(id)) return id;
  }
  throw new Error("could not allocate a group id");
}

/** Validate the writable fields of a group body; `{ error }` means 400. */
function groupInput(body, { required = false } = {}) {
  const out = {};
  if ("name" in body) {
    if (typeof body.name !== "string") return { error: 'expected "name" to be a string' };
    const name = body.name.trim();
    if (!name) return { error: "name is required" };
    if ([...name].length > GROUP_NAME_MAX) return { error: `name is longer than ${GROUP_NAME_MAX} characters` };
    out.name = name;
  } else if (required) {
    return { error: 'expected "name" to be a string' };
  }
  if ("color" in body && body.color !== null && body.color !== undefined) {
    if (!GROUP_COLORS.includes(body.color)) return { error: `color must be one of ${GROUP_COLORS.join(", ")}` };
    out.color = body.color;
  }
  return out;
}

async function apiGroupsList(res) {
  const { groups } = await readGroupStore();
  const counts = await groupCounts();
  json(res, 200, {
    groups: groups.map((group) => ({ ...groupView(group), count: counts.get(group.id) || 0 })),
  });
}

async function apiGroupCreate(res, req) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return fail(res, 400, "body is not valid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail(res, 400, "expected a JSON object");

  const input = groupInput(body, { required: true });
  if (input.error) return fail(res, 400, input.error);

  const outcome = await withGroupsLock(async () => {
    const { groups } = await readGroupStore();
    if (groups.some((group) => sameGroupName(group.name, input.name))) return { conflict: true };
    const now = new Date().toISOString();
    const group = {
      id: await newGroupId(groups),
      name: input.name,
      color: input.color || "violet",
      createdAt: now,
      updatedAt: now,
    };
    groups.push(group); // group order is array order: new groups append
    await writeGroupStore(groups);
    return { group };
  });

  if (outcome.conflict) return fail(res, 409, `group name already exists: ${input.name}`);
  log("group created", outcome.group.id, outcome.group.name);
  scheduleGalleryRebuild();
  json(res, 201, { group: groupView(outcome.group) });
}

async function apiGroupPatch(res, req, id) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return fail(res, 400, "body is not valid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail(res, 400, "expected a JSON object");

  const input = groupInput(body);
  if (input.error) return fail(res, 400, input.error);
  if (input.name === undefined && input.color === undefined) return fail(res, 400, 'expected "name" or "color" to be set');

  const outcome = await withGroupsLock(async () => {
    const { groups } = await readGroupStore();
    const group = groups.find((entry) => entry.id === id);
    if (!group) return { missing: true };
    if (input.name !== undefined && groups.some((entry) => entry !== group && sameGroupName(entry.name, input.name))) {
      return { conflict: true };
    }
    if (input.name !== undefined) group.name = input.name;
    if (input.color !== undefined) group.color = input.color;
    group.updatedAt = new Date().toISOString();
    await writeGroupStore(groups);
    return { group };
  });

  if (outcome.missing) return fail(res, 404, `group not found: ${id}`);
  if (outcome.conflict) return fail(res, 409, `group name already exists: ${input.name}`);
  log("group updated", outcome.group.id, outcome.group.name);
  scheduleGalleryRebuild();
  json(res, 200, { group: groupView(outcome.group) });
}

async function apiGroupDelete(res, id) {
  const outcome = await withGroupsLock(async () => {
    const { groups } = await readGroupStore();
    const index = groups.findIndex((group) => group.id === id);
    if (index === -1) return { missing: true };
    groups.splice(index, 1);
    await writeGroupStore(groups);

    // Every board that includes the group loses just that id; its other groups
    // stay. Only the membership keys are rewritten: title/subtitle/tags (and
    // anything hand-added) stay exactly as they were.
    let moved = 0;
    for (const [boardId] of await listBoards()) {
      const meta = await readMeta(boardId);
      if (!groupIdsOf(meta).includes(id)) continue;
      let cleared = false;
      await withBoardLock(boardId, async () => {
        await migrateLegacy(boardId);
        const current = await readMeta(boardId);
        const before = groupIdsOf(current);
        const kept = before.filter((groupId) => groupId !== id);
        if (kept.length === before.length) return; // a concurrent patch already moved it
        await mkdir(boardDir(boardId), { recursive: true });
        const next = { ...current, groupIds: kept, groupId: kept[0] || null };
        await writeAtomic(metaPath(boardId), `${JSON.stringify(next, null, 2)}\n`);
        cleared = true;
      });
      if (cleared) moved += 1;
    }
    return { moved };
  });

  if (outcome.missing) return fail(res, 404, `group not found: ${id}`);
  log("group deleted", id, `(${outcome.moved} board(s) moved)`);
  scheduleGalleryRebuild();
  json(res, 200, { deleted: id, moved: outcome.moved });
}

/* ---------------------------------------------------------- catalogue sync */

/**
 * Rewrite the catalogue (index.html + manifest.json) shortly after a board
 * changes, so the home page never lists a board that is gone or misses a new
 * one. The container sets GALLERY_BUILD=/srv/tools/build.mjs; without it
 * (plain `node server.mjs` in development) the host runs gallery/build.mjs.
 *
 * Debounced and fire-and-forget: a burst of keystroke saves costs one rebuild,
 * and a failure only logs — saving a board never fails because of the catalog.
 */
let galleryTimer = null;
let galleryRunning = false;
const GALLERY_BUILD_AVAILABLE = Boolean(GALLERY_BUILD) && existsSync(GALLERY_BUILD);

function scheduleGalleryRebuild() {
  if (!GALLERY_BUILD_AVAILABLE) return;
  if (galleryTimer) clearTimeout(galleryTimer);
  galleryTimer = setTimeout(() => {
    galleryTimer = null;
    if (galleryRunning) return scheduleGalleryRebuild(); // one at a time
    galleryRunning = true;
    const child = spawn(process.execPath, [GALLERY_BUILD, "--no-render"], {
      env: { ...process.env, SCENES_DIR: DATA_DIR, SITE_DIR: GALLERY_DIR },
      stdio: "ignore",
    });
    child.on("error", (err) => {
      galleryRunning = false;
      log("catalogue rebuild failed:", err.message);
    });
    child.on("exit", (code) => {
      galleryRunning = false;
      if (code !== 0) log("catalogue rebuild exited with", code);
    });
  }, 1200);
  galleryTimer.unref?.();
}

/* --------------------------------------------------------------------- api */

/** Every board in DATA_DIR — folder layout first, never-migrated flat boards after. */
async function listBoards() {
  let names;
  try {
    names = await readdir(DATA_DIR);
  } catch {
    return [];
  }
  const found = new Map(); // id -> absolute scene file
  for (const name of names) {
    if (name.startsWith(".") || !ID_RE.test(name)) continue;
    const dir = join(DATA_DIR, name);
    if (!(await dirExists(dir))) continue;
    const scene = join(dir, "scene.excalidraw");
    if (await fileExists(scene)) found.set(name, scene);
  }
  for (const name of names) {
    if (name.startsWith(".") || !SCENE_RE.test(name)) continue;
    const id = name.replace(SCENE_RE, "");
    if (found.has(id) || !ID_RE.test(id)) continue;
    const file = join(DATA_DIR, name);
    if (await fileExists(file)) found.set(id, file);
  }
  return [...found.entries()];
}

/*
 * The catalogue's per-card element count. Parsing every scene on every
 * /api/boards costs ~1ms per board and grows with the library, yet a scene only
 * changes when its file changes — so the count is cached against its mtime.
 */
const countCache = new Map(); // id -> { mtimeMs, elements }

async function countElements(id, path, info) {
  const cached = countCache.get(id);
  if (cached && cached.mtimeMs === info.mtimeMs) return cached.elements;
  let elements = null;
  try {
    const scene = JSON.parse(await readFile(path, "utf8"));
    elements = Array.isArray(scene.elements) ? scene.elements.filter((e) => !e.isDeleted).length : null;
  } catch {
    /* unreadable scene: still list it */
  }
  countCache.set(id, { mtimeMs: info.mtimeMs, elements });
  return elements;
}

async function apiList(res) {
  const boards = [];
  const live = await liveGroupIds();
  for (const [id, path] of await listBoards()) {
    try {
      const info = await stat(path);
      const meta = await readMeta(id);
      const groupIds = groupIdsOf(meta, live);
      const elements = await countElements(id, path, info);
      boards.push({
        id,
        title: meta?.title ? String(meta.title) : id,
        subtitle: meta?.subtitle ? String(meta.subtitle) : "",
        // groupId stays for older clients and mirrors the first membership;
        // groupIds is always an array ([] = no group) so a card can render it
        groupId: groupIds[0] || null,
        groupIds,
        bytes: info.size,
        updated: info.mtimeMs,
        elements,
      });
    } catch {
      /* racing delete */
    }
  }
  boards.sort((a, b) => b.updated - a.updated);
  json(res, 200, { boards });
}

async function apiCreate(res, req) {
  let wanted = "";
  try {
    const body = await readBody(req);
    if (body.trim()) wanted = JSON.parse(body).name || "";
  } catch {
    /* empty body is fine */
  }
  const id = await uniqueId(wanted || `board-${new Date().toISOString().slice(0, 16).replace(/[:T-]/g, "")}`);
  const scene = emptyScene();
  await mkdir(boardDir(id), { recursive: true });
  await writeAtomic(scenePath(id), `${JSON.stringify(scene, null, 2)}\n`);
  log("created", id);
  scheduleGalleryRebuild();
  json(res, 201, { id, scene });
}

async function apiGet(res, id) {
  const file = await sceneFile(id);
  if (!file) return fail(res, 404, `board not found: ${id}`);
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return fail(res, 404, `board not found: ${id}`);
  }
  // A scene is served byte-for-byte: membership lives in the sidecar and rides
  // on /api/boards and /api/boards/:id/meta, not inside the Excalidraw document
  // (re-encoding a multi-megabyte scene on every open only costs time).
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(raw);
}

async function apiPut(res, req, id) {
  const raw = await readBody(req);
  let scene;
  try {
    scene = JSON.parse(raw);
  } catch {
    return fail(res, 400, "body is not valid JSON");
  }
  if (scene?.type !== "excalidraw" || !Array.isArray(scene.elements)) {
    return fail(res, 400, 'expected a scene object with type "excalidraw" and an elements array');
  }
  // a tab left open on a board that somebody deleted must not bring it back:
  // only POST /api/boards creates a board, a PUT writes an existing one
  if (!(await boardExists(id))) return fail(res, 404, `board not found: ${id}`);
  await withBoardLock(id, () => saveScene(id, scene));
  scheduleGalleryRebuild();
  json(res, 200, { id, elements: scene.elements.length, savedAt: Date.now() });
}

async function apiDelete(res, id) {
  if (!(await boardExists(id))) return fail(res, 404, `board not found: ${id}`);
  countCache.delete(id);
  // the folder owns the scene, its sidecar and its snapshots: deleting the
  // board means deleting the folder, not just the file it happens to live in
  await rm(boardDir(id), { recursive: true, force: true });
  // legacy leftovers of a board that was never migrated
  await unlink(legacyScenePath(id)).catch(() => {});
  await unlink(legacyMetaPath(id)).catch(() => {});
  await rm(legacyHistoryDir(id), { recursive: true, force: true }).catch(() => {});
  await rmdir(join(DATA_DIR, ".history")).catch(() => {}); // only when empty
  const peers = rooms.get(id);
  if (peers) {
    for (const socket of peers) {
      try {
        socket.send(JSON.stringify({ type: "deleted", board: id }));
        socket.close(4004, "board deleted");
      } catch {
        /* socket already gone */
      }
    }
    rooms.delete(id);
  }
  log("deleted", id);
  scheduleGalleryRebuild();
  json(res, 200, { id, deleted: true });
}

/* ----------------------------------------------------------------- history */

/*
 * GET /api/boards/:id/history — the snapshots this server actually keeps on
 * disk, newest first. File names only: a client has no business learning where
 * DATA_DIR is. Excalidraw's own undo stack lives in the tab's memory and is
 * never written anywhere; these snapshots are the only persisted history.
 */
async function apiHistory(res, id) {
  if (!(await boardExists(id))) return fail(res, 404, `board not found: ${id}`);
  const history = (await historyFiles(id)).map(({ name, bytes, mtimeMs }) => ({
    name,
    bytes,
    savedAt: new Date(mtimeMs).toISOString(),
  }));
  json(res, 200, { id, keep: HISTORY_KEEP, history });
}

/* -------------------------------------------------------------------- live */

/*
 * One WebSocket room per board: /ws/board/<id>
 *
 * Excalidraw has no merge algorithm of its own, so clients send their whole
 * scene and receivers merge element-by-element by `version`/`versionNonce`
 * (the same fields Excalidraw bumps on every edit). That keeps two people
 * drawing at the same time from wiping each other's shapes, and it converges:
 * whoever still holds an element the other side lacks re-sends the merged set.
 *
 * The socket owns persistence while it is open (debounced, 350 ms); the HTTP
 * PUT stays as the fallback for tabs that only ever open one connection.
 */
const rooms = new Map(); // boardId -> Set<ws>
const saveQueue = new Map(); // boardId -> {scene, timer, waiters}
const PEER_COLORS = ["#7c8cff", "#ff8a5c", "#3ecf8e", "#f5c451", "#ff6b9d", "#5cc8ff", "#b18cff"];

// A tab keeps one id in sessionStorage, so a reload can replace its own old
// socket instead of looking like a second person. Malformed ids are ignored.
const SID_RE = /^[A-Za-z0-9_-]{8,64}$/;

// A browser that vanishes without closing its socket (sleep, lost Wi-Fi,
// Tailscale drop) never sends a close frame, so the only way to keep the
// presence honest is to ping and drop whatever stops answering.
const HEARTBEAT_MS = (() => {
  const raw = Number(process.env.HEARTBEAT_MS);
  return Number.isFinite(raw) && raw >= 100 ? raw : 30_000;
})();

const roomOf = (id) => {
  let room = rooms.get(id);
  if (!room) rooms.set(id, (room = new Set()));
  return room;
};

function broadcast(id, message, except) {
  const room = rooms.get(id);
  if (!room) return;
  const text = JSON.stringify(message);
  for (const client of room) {
    if (client === except || client.readyState !== 1) continue;
    client.send(text);
  }
}

const presenceOf = (id) => ({
  type: "presence",
  peers: [...(rooms.get(id) || [])].map((c) => ({ id: c.peerId, name: c.peerName, color: c.peerColor })),
});

const announce = (id) => broadcast(id, presenceOf(id));

/** Debounced write: a burst of dragging becomes one snapshot on disk. */
function queuePersist(id, scene, done) {
  let entry = saveQueue.get(id);
  if (!entry) saveQueue.set(id, (entry = { scene: null, timer: 0, waiters: [] }));
  entry.scene = scene;
  entry.waiters.push(done);
  if (entry.timer) return;
  entry.timer = setTimeout(async () => {
    entry.timer = 0;
    const payload = entry.scene;
    const waiters = entry.waiters.splice(0);
    entry.scene = null;
    if (!payload) return;
    try {
      // deleting a board closes its room, but a frame already in flight would
      // otherwise recreate the folder on disk
      if (!(await boardExists(id))) {
        for (const w of waiters) w(false);
        return;
      }
      await withBoardLock(id, () => saveScene(id, payload));
      for (const w of waiters) w(true);
    } catch (error) {
      log("ws save failed", id, error?.message);
      for (const w of waiters) w(false);
    }
  }, 350);
}

const live = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY });

live.on("connection", (ws, request, id) => {
  if (!rooms.has(id)) roomOf(id);
  const room = roomOf(id);
  const params = new URL(request.url, "http://x").searchParams;
  const sidParam = String(params.get("sid") || "");
  ws.peerSid = SID_RE.test(sidParam) ? sidParam : null;
  ws.peerName = String(params.get("name") || "").slice(0, 40) || "ไม่ระบุชื่อ";

  // the same tab reconnecting (reload, network blip) takes its old slot back:
  // dropping the previous socket keeps one person at one place in the room
  if (ws.peerSid) {
    for (const other of room) {
      if (other === ws || other.peerSid !== ws.peerSid) continue;
      other.replaced = true;
      room.delete(other);
      try {
        other.send(JSON.stringify({ type: "replaced" }));
        other.close(4001, "replaced");
      } catch {
        /* already gone */
      }
      setTimeout(() => other.terminate(), 1_000).unref?.();
    }
  }

  const taken = new Set([...room].map((c) => c.peerColor));
  ws.peerId = `p${Math.random().toString(36).slice(2, 9)}`;
  ws.peerColor = PEER_COLORS.find((c) => !taken.has(c)) || PEER_COLORS[room.size % PEER_COLORS.length];
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });
  room.add(ws);

  const send = (message) => ws.readyState === 1 && ws.send(JSON.stringify(message));
  send({ type: "welcome", board: id, you: { id: ws.peerId, name: ws.peerName, color: ws.peerColor } });
  announce(id);

  ws.on("message", (raw) => {
    if (raw.length > MAX_BODY) return;
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;

    if (message.type === "update") {
      const scene = message.scene;
      if (scene?.type !== "excalidraw" || !Array.isArray(scene.elements)) return;
      queuePersist(id, scene, (ok) => send({ type: ok ? "saved" : "save-failed", at: Date.now() }));
      broadcast(id, { type: "update", from: ws.peerId, scene }, ws);
      return;
    }

    if (message.type === "pointer") {
      const x = Number(message.x);
      const y = Number(message.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      // a laser packet carries the pointer mode and the button state, so the
      // other tab can draw a trail between the points instead of a dot
      broadcast(
        id,
        {
          type: "pointer",
          from: ws.peerId,
          color: ws.peerColor,
          x,
          y,
          tool: message.tool === "laser" ? "laser" : "pointer",
          button: message.button === "down" ? "down" : "up",
        },
        ws,
      );
    }
  });

  ws.on("close", () => {
    // a replaced socket already left the room and its replacement announced
    // the new presence — saying it again would only repeat the same frame
    if (ws.replaced) return;
    room.delete(ws);
    if (!room.size) rooms.delete(id);
    announce(id);
  });
  ws.on("error", () => {});
});

/* One sweeper for every room: a socket that still has not answered the previous
 * ping is gone as far as anyone can tell, so it leaves the presence right now
 * instead of lingering until the OS notices the dead connection. */
const heartbeat = setInterval(() => {
  for (const room of rooms.values()) {
    for (const ws of room) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }
}, HEARTBEAT_MS);
heartbeat.unref?.();

/* ------------------------------------------------------------------ routing */


const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = decodeURIComponent(url.pathname);
  const method = req.method || "GET";

  try {
    if (path === "/api/health") return json(res, 200, { ok: true, commit: BUILD.commit, date: BUILD.date, dataDir: DATA_DIR });

    if (path === "/api/boards") {
      if (method === "GET") return await apiList(res);
      if (method === "POST") return await apiCreate(res, req);
      return fail(res, 405, "method not allowed");
    }

    const metaMatch = path.match(/^\/api\/boards\/([^/]+)\/meta$/);
    if (metaMatch) {
      const id = metaMatch[1];
      if (!ID_RE.test(id)) return fail(res, 400, "invalid board id");
      if (method === "GET") return await apiMetaGet(res, id);
      if (method === "PATCH") return await apiMetaPatch(res, req, id);
      return fail(res, 405, "method not allowed");
    }

    const historyMatch = path.match(/^\/api\/boards\/([^/]+)\/history$/);
    if (historyMatch) {
      const id = historyMatch[1];
      if (!ID_RE.test(id)) return fail(res, 400, "invalid board id");
      if (method === "GET") return await apiHistory(res, id);
      return fail(res, 405, "method not allowed");
    }

    const boardMatch = path.match(/^\/api\/boards\/([^/]+)$/);
    if (boardMatch) {
      const id = boardMatch[1];
      if (!ID_RE.test(id)) return fail(res, 400, "invalid board id");
      if (method === "GET") return await apiGet(res, id);
      if (method === "PUT") return await apiPut(res, req, id);
      if (method === "DELETE") return await apiDelete(res, id);
      return fail(res, 405, "method not allowed");
    }

    if (path === "/api/groups") {
      if (method === "GET") return await apiGroupsList(res);
      if (method === "POST") return await apiGroupCreate(res, req);
      return fail(res, 405, "method not allowed");
    }

    const groupMatch = path.match(/^\/api\/groups\/([^/]+)$/);
    if (groupMatch) {
      const id = groupMatch[1];
      if (method === "PATCH") return await apiGroupPatch(res, req, id);
      if (method === "DELETE") return await apiGroupDelete(res, id);
      return fail(res, 405, "method not allowed");
    }

    if (method !== "GET" && method !== "HEAD") return fail(res, 405, "method not allowed");

    if (path.startsWith("/scenes/")) {
      const raw = path.slice("/scenes/".length);
      // The download URL stayed `/scenes/<id>.excalidraw` while the file on
      // disk moved into `<id>/`; the on-disk shape is not a public URL (it
      // would expose history/), so it just points at the canonical one.
      const onDisk = raw.match(/^([^/]+)\/scene\.excalidraw$/i);
      if (onDisk && ID_RE.test(onDisk[1])) {
        return send(res, 301, "", { Location: `/scenes/${encodeURIComponent(onDisk[1])}.excalidraw` });
      }
      const direct = raw.match(/^([^/]+)\.excalidraw$/i);
      if (direct && ID_RE.test(direct[1])) {
        const file = await sceneFile(direct[1]);
        if (file && (await serveFile(req, res, file))) return;
      }
      return fail(res, 404, "scene not found");
    }

    if (path === "/gallery" || path.startsWith("/gallery/")) {
      const rel = path.replace(/^\/gallery\/?/, "");
      const candidate = rel === "" || path.endsWith("/") ? join(rel, "index.html") : rel;
      const file = within(GALLERY_DIR, candidate);
      if (file && (await serveFile(req, res, file))) return;
      const dirIndex = within(GALLERY_DIR, join(candidate, "index.html"));
      if (dirIndex && (await serveFile(req, res, dirIndex))) return;
      return fail(res, 404, "not found in gallery");
    }

    // the catalogue is the landing page
    if (path === "/" || path === "/index.html") {
      const home = within(GALLERY_DIR, "index.html");
      if (await serveFile(req, res, home, { cache: "no-cache" })) return;
    }

    // app shell + its hashed assets
    const asset = within(APP_DIR, path === "/" ? "index.html" : path);
    const hashed = path.startsWith("/assets/"); // content-addressed: never revalidate
    const assetCache = hashed ? "public, max-age=31536000, immutable" : "no-cache";
    if (asset && (await serveFile(req, res, asset, { cache: assetCache, revalidate: !hashed }))) return;

    // Only these two shapes are editor routes. Everything else is a genuine
    // 404 — serving the editor shell for any unknown path made a mistyped
    // address look like a broken board.
    const shell = join(APP_DIR, "index.html");
    const boardRoute = path.match(/^\/b\/([^/]+)\/?$/);
    if (boardRoute) {
      const id = decodeURIComponent(boardRoute[1]);
      const known = ID_RE.test(id) && (await boardExists(id));
      // the shell always renders; 404 tells the browser the board is missing
      if (await serveFile(req, res, shell, { status: known ? 200 : 404 })) return;
    }
    if (path === "/new" || path === "/new/") {
      if (await serveFile(req, res, shell)) return;
    }
    return send(res, 404, notFoundPage(path), { "Content-Type": "text/html; charset=utf-8" });
  } catch (error) {
    const status = error?.status || 500;
    log("error", method, path, error?.message);
    if (!res.headersSent) fail(res, status, error?.message || "internal error");
    else res.end();
  }
});

server.on("upgrade", (request, socket, head) => {
  let id = null;
  try {
    const match = new URL(request.url, "http://localhost").pathname.match(/^\/ws\/board\/([^/]+)$/);
    if (match) id = decodeURIComponent(match[1]);
  } catch {
    id = null;
  }
  if (!id || !ID_RE.test(id)) {
    socket.destroy();
    return;
  }
  live.handleUpgrade(request, socket, head, (ws) => live.emit("connection", ws, request, id));
});

/* ----------------------------------------------------- build-time precompress */

/**
 * `node server.mjs --precompress <dir>` writes `<file>.br` and `<file>.gz` next
 * to every text asset, so the runtime never brotli-compresses the SPA bundle.
 * The image build runs it once; serveFile prefers those files while fresh.
 */
async function precompress(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  let written = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath ?? dir, entry.name);
    if (!COMPRESSIBLE.has(extname(file).toLowerCase())) continue;
    const info = await stat(file);
    if (info.size < COMPRESS_MIN) continue;
    const body = await readFile(file);
    for (const encoding of ["br", "gzip"]) {
      const made = await compressBody(encoding, body, info.size);
      if (made.length >= body.length) continue;
      await writeFile(file + (encoding === "br" ? ".br" : ".gz"), made);
      written += 1;
    }
  }
  log(`precompressed ${written} file(s) under ${dir}`);
}

const precompressAt = process.argv.indexOf("--precompress");
if (precompressAt !== -1) {
  await precompress(resolve(process.argv[precompressAt + 1] || "dist"));
  process.exit(0);
}

async function boot() {
  log(`build ${BUILD.commit} (${BUILD.date})`);
  // a crashed writer's temps must go before anything lists or saves boards
  await sweepAllSceneTemps().catch((error) => log("temp sweep failed:", error?.message));
  server.listen(PORT, "0.0.0.0", () => {
    log(`boards server on :${PORT}`);
    log(`data   ${DATA_DIR}`);
    log(`app    ${APP_DIR}`);
    log(`gallery ${GALLERY_DIR}` + (GALLERY_BUILD_AVAILABLE ? ` (rebuilds via ${GALLERY_BUILD})` : ""));
  });
}

await boot();

