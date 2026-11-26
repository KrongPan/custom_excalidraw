#!/usr/bin/env node
/**
 * gallery/build.mjs — turn a folder of board folders into a browsable catalog.
 *
 * Why this exists: the self-hosted Excalidraw image is a static frontend with no
 * storage of its own. Boards live as folders on disk; this script is the missing
 * "index": it scans gallery/scenes/, renders a PNG preview of each board, and
 * writes a static gallery page next to the app.
 *
 * Usage
 *   node gallery/build.mjs              # render missing/stale thumbnails, write site/
 *   node gallery/build.mjs --force      # re-render every thumbnail
 *   node gallery/build.mjs --no-render  # catalog only (thumbnails must exist)
 *   SCENES_DIR=/tmp/x SITE_DIR=/tmp/y node gallery/build.mjs --no-render
 *
 * Per-scene metadata (optional)
 *   gallery/scenes/<id>/meta.json
 *     { "title": "...", "subtitle": "...", "tags": ["..."] }
 *   Without it the title is derived from the folder name.
 *
 * Board layout (one folder per board, written by app/server.mjs)
 *   <scenes>/<id>/scene.excalidraw            the board
 *   <scenes>/<id>/meta.json                   optional sidecar
 *   <scenes>/<id>/history/<stamp>.excalidraw  saved snapshots — never scanned
 *
 * Old flat boards (`<scenes>/<id>.excalidraw` + `<id>.meta.json`) are still
 * picked up so a never-migrated board does not vanish from the catalogue.
 *
 * Output (gallery/site/, mounted read-only at /site in the container)
 *   index.html            catalog page
 *   manifest.json         the same data, machine readable
 *   thumbs/<slug>.png     preview images
 *   scenes/<slug>.excalidraw   copies the app downloads / deep-links to
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const ROOT = resolve(HERE, "..");
/* Both roots are overridable so a test can build a throwaway catalog. */
const SCENES = resolve(process.env.SCENES_DIR || join(HERE, "scenes"));
const SITE = resolve(process.env.SITE_DIR || join(HERE, "site"));
const THUMBS = join(SITE, "thumbs");
const OUT_SCENES = join(SITE, "scenes");
/* The brand marks live in the repo so both the SPA and this catalogue can use
   them; copied into the site on every build because the site is disposable. */
const LOGO_DIR = resolve(process.env.LOGO_DIR || join(ROOT, "assets", "logo"));
const LOGO_FILES = ["logo-32.png", "logo-64.png", "logo-180.png"];

const CLI = process.env.EXCALIDRAW_BIN || "excalidraw";
const FORCE = process.argv.includes("--force");
const NO_RENDER = process.argv.includes("--no-render");
const CONCURRENCY = Number(process.env.RENDER_CONCURRENCY || 2);
const THUMB_MAX_WIDTH = Number(process.env.THUMB_MAX_WIDTH || 1100);

/** Anything older than this is not a real "last edited" stamp (epoch ms). */
const MIN_PLAUSIBLE_MS = Date.UTC(2020, 0, 1);

/* --------------------------------------------------------------- utilities */

const pad = (n) => String(n).padStart(2, "0");

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** "inventory-board-2026-11-24" -> "Inventory board 2026 11 24" (readable fallback) */
function humanize(slug) {
  const words = slug.split("-").filter(Boolean);
  return words
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function formatDay(ms) {
  const d = new Date(ms);
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

function formatDate(ms) {
  const d = new Date(ms);
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Read width/height straight out of a PNG's IHDR chunk. */
function pngSize(file) {
  try {
    const b = readFileSync(file);
    if (b.length < 24 || b.toString("ascii", 12, 16) !== "IHDR") return null;
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  } catch {
    return null;
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ------------------------------------------------------------------ scenes */

function readMetaFile(metaPath) {
  if (!existsSync(metaPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(metaPath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    process.stderr.write(`  ! ignoring bad ${basename(metaPath)}: ${error.message}\n`);
    return {};
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function collectScenes() {
  if (!existsSync(SCENES)) {
    // first boot of a fresh install: nothing mounted/created yet, which is the
    // same as an empty library — the empty catalogue below is the answer
    process.stderr.write(`scenes folder not found, treating as empty: ${SCENES}\n`);
    return [];
  }
  const names = readdirSync(SCENES).sort();
  const scenes = [];
  const ids = new Set();
  const slugs = new Map();

  const add = (id, path, metaPath) => {
    if (!id || ids.has(id)) return;
    const slug = slugify(id) || "scene";
    if (slugs.has(slug)) {
      process.stderr.write(`  ! skipping ${id}: slug ${slug} already used by ${slugs.get(slug)}\n`);
      return;
    }
    ids.add(id);
    slugs.set(slug, id);
    scenes.push({ id, file: path, path, slug, meta: readMetaFile(metaPath) });
  };

  // Current layout: <scenes>/<id>/scene.excalidraw. Snapshots live in
  // <id>/history/, one level below the file we read, so they are never scanned.
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const dir = join(SCENES, name);
    if (!isDirectory(dir)) continue;
    const scene = join(dir, "scene.excalidraw");
    if (existsSync(scene)) add(name, scene, join(dir, "meta.json"));
  }

  // Legacy flat layout: <scenes>/<id>.excalidraw, still read by the server
  // until that board's next save moves it into a folder.
  for (const name of names) {
    if (name.startsWith(".") || extname(name) !== ".excalidraw") continue;
    const id = basename(name, ".excalidraw");
    const file = join(SCENES, name);
    let isFile = false;
    try {
      isFile = statSync(file).isFile();
    } catch {
      /* dangling entry */
    }
    if (isFile) add(id, file, join(SCENES, `${id}.meta.json`));
  }

  // A sidecar whose scene is gone is ignored, but it lingers on disk — say so
  // instead of leaving a puzzle.
  for (const name of names) {
    if (name.startsWith(".") || !name.endsWith(".meta.json")) continue;
    const id = name.slice(0, -".meta.json".length);
    if (!ids.has(id)) {
      process.stderr.write(`  ! orphan ${name}: no ${id}/scene.excalidraw and no ${id}.excalidraw (ignored)\n`);
    }
  }

  return scenes;
}

function describeScene(scene) {
  const raw = JSON.parse(readFileSync(scene.path, "utf8"));
  const elements = Array.isArray(raw.elements) ? raw.elements : [];
  const live = elements.filter((el) => !el.isDeleted);
  const frames = live.filter((el) => el.type === "frame").length;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const el of live) {
    minX = Math.min(minX, el.x ?? 0);
    minY = Math.min(minY, el.y ?? 0);
    maxX = Math.max(maxX, (el.x ?? 0) + (el.width ?? 0));
    maxY = Math.max(maxY, (el.y ?? 0) + (el.height ?? 0));
  }
  const hasBox = Number.isFinite(minX) && Number.isFinite(maxX);

  // Older boards carry `updated: 0` (or a seconds-based value), which would
  // render as "1 Jan 1970". Only trust element timestamps that look like
  // epoch milliseconds; otherwise fall back to the file's own mtime.
  const stamps = live
    .map((el) => el.updated ?? 0)
    .filter((t) => t >= MIN_PLAUSIBLE_MS);
  const updated = stamps.length ? Math.max(...stamps) : 0;

  return {
    elements: live.length,
    frames,
    width: hasBox ? Math.round(maxX - minX) : 0,
    height: hasBox ? Math.round(maxY - minY) : 0,
    size: statSync(scene.path).size,
    updated: updated || statSync(scene.path).mtimeMs,
  };
}

// How much of the bento grid a board deserves: a busy board or a big canvas
// gets the wide/large tile, a tall board gets the extra row. Only the bento
// layout reads data-weight, so this never changes the card or list view.
const WEIGHT_LARGE_ELEMENTS = 60;
const WEIGHT_LARGE_AREA = 1500000;
const WEIGHT_WIDE_ELEMENTS = 25;
const WEIGHT_WIDE_AREA = 600000;
const WEIGHT_TALL_AREA = 250000;
const WEIGHT_TALL_RATIO = 1.6;

function sceneWeight(elements, width, height) {
  const count = Number(elements) || 0;
  const w = Math.max(0, Math.round(Number(width) || 0));
  const h = Math.max(0, Math.round(Number(height) || 0));
  const area = w * h;
  if (count >= WEIGHT_LARGE_ELEMENTS || area >= WEIGHT_LARGE_AREA) return "large";
  if (count >= WEIGHT_WIDE_ELEMENTS || area >= WEIGHT_WIDE_AREA) return "wide";
  if (h > w * WEIGHT_TALL_RATIO && area >= WEIGHT_TALL_AREA) return "tall";
  return "small";
}

/* --------------------------------------------------------------- rendering */

function runProcess(cmd, args) {
  return new Promise((resolvePromise) => {
    let stderr = "";
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      resolvePromise({ ok: false, error: error.message });
      return;
    }
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => resolvePromise({ ok: false, error: error.message }));
    child.on("close", (code) =>
      resolvePromise({
        ok: code === 0,
        error: code === 0 ? "" : stderr.trim().split("\n").slice(-4).join("\n"),
      }),
    );
  });
}

async function renderThumbnail(scene, thumbPath) {
  const sceneAge = statSync(scene.path).mtimeMs;
  if (!FORCE && existsSync(thumbPath) && statSync(thumbPath).mtimeMs >= sceneAge) {
    return { ok: true, cached: true };
  }
  if (NO_RENDER) {
    // --no-render never renders: it only reuses what the host already produced,
    // so a missing preview is "not yet", not a failure
    return { ok: existsSync(thumbPath), cached: true, skipped: true };
  }
  /* Render beside the final file and rename over it: a render killed halfway
     (Ctrl-C, a page closed under the CLI) must never leave a truncated PNG or a
     thumbnail that looks fresher than the board. The temp name lives in SITE,
     not THUMBS, so a concurrent build's orphan sweep cannot delete it. */
  const tmp = join(SITE, `.thumb-${process.pid}-${scene.slug}.png`);
  const result = await runProcess(CLI, [
    "render",
    scene.path,
    "--out",
    tmp,
    "--max-width",
    String(THUMB_MAX_WIDTH),
    "--padding",
    "28",
  ]);
  if (!result.ok) {
    rmSync(tmp, { force: true });
    return { ...result, cached: false };
  }
  renameSync(tmp, thumbPath);
  /* Stamp the PNG with the scene it was rendered from. If the board is saved
     again while the browser renders it, the scene ends up newer than the stamp
     and the next run renders it again — otherwise the picture of an older state
     would count as fresh forever. */
  try {
    utimesSync(thumbPath, new Date(), new Date(Math.ceil(sceneAge)));
  } catch {
    /* the round-to-ms stamp is a nicety; the PNG itself is already correct */
  }
  return { ...result, cached: false };
}

/** Write a page atomically so a reader never opens a half-written file. */
function writeAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

/** Small worker pool so a handful of boards renders without spawning all at once. */
async function mapWithLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/* -------------------------------------------------------------------- page */

function renderPage(entries, generatedAt) {
  const ICON_DOWNLOAD =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 4v11"/><path d="M7.5 11.5L12 16l4.5-4.5"/><path d="M5 20h14"/></svg>';
  const ICON_TRASH =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6 7l1 13h10l1-13"/></svg>';
  const ICON_PENCIL =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3z"/></svg>';
  const ICON_CHEVRON =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M6 9l6 6 6-6"/></svg>';
  // three layouts for the board list: two tall cards, rows, and a bento tile set
  const ICON_VIEW_CARD =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="3.5" y="3.5" width="7" height="17" rx="1.8"/><rect x="13.5" y="3.5" width="7" height="17" rx="1.8"/></svg>';
  const ICON_VIEW_LIST =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="3" y="4" width="4.5" height="4.5" rx="1.2"/><path d="M10.5 6.2h10.5"/><rect x="3" y="9.8" width="4.5" height="4.5" rx="1.2"/><path d="M10.5 12h10.5"/><rect x="3" y="15.5" width="4.5" height="4.5" rx="1.2"/><path d="M10.5 17.8h10.5"/></svg>';
  const ICON_VIEW_BENTO =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="3" y="3" width="9.5" height="9.5" rx="1.8"/><rect x="15" y="3" width="6" height="4.5" rx="1.4"/><rect x="15" y="10" width="6" height="11" rx="1.8"/><rect x="3" y="15" width="9.5" height="6" rx="1.4"/></svg>';

  const cards = entries
    .map((entry) => {
      const href = `/b/${encodeURIComponent(entry.slug)}`;
      const download = `/scenes/${entry.slug}.excalidraw`;
      const preview = entry.thumb
        ? `<img src="/gallery/thumbs/${entry.slug}.png?${entry.mtime}" alt="" loading="lazy">`
        : `<span class="placeholder">ยังไม่มีภาพตัวอย่าง</span>`;
      const bits = [
        `${entry.elements} elements`,
        entry.frames ? `${entry.frames} frames` : null,
        entry.width ? `${entry.width}×${entry.height}` : null,
        `${entry.sizeLabel}`,
        formatDay(entry.updated),
      ].filter(Boolean);
      // data-group/data-groups are only hints from meta.json; the server's
      // /api/groups answer wins once it arrives (see loadMembership below).
      const groupHints = Array.isArray(entry.groupIds)
        ? entry.groupIds
        : entry.groupId
          ? [entry.groupId]
          : [];
      // data-weight only drives the bento spans; every other view ignores it.
      return `      <article class="card" data-slug="${escapeHtml(entry.slug)}" data-weight="${escapeHtml(
        entry.weight || "small",
      )}" data-group="${escapeHtml(
        entry.groupId || "",
      )}" data-groups="${escapeHtml(groupHints.join(" "))}" data-search="${escapeHtml(
        `${entry.title} ${entry.subtitle} ${entry.slug}`.toLowerCase(),
      )}">
        <a class="shot" href="${href}" aria-label="เปิด ${escapeHtml(entry.title)}">${preview}</a>
        <div class="body">
          <h2>${escapeHtml(entry.title)}</h2>
          ${entry.subtitle ? `<p class="sub">${escapeHtml(entry.subtitle)}</p>` : ""}
          <p class="meta" title="${escapeHtml(formatDate(entry.updated))}">${escapeHtml(bits.join(" · "))}</p>
          <div class="group-pick" hidden>
            <button type="button" class="card-group" data-slug="${escapeHtml(
              entry.slug,
            )}" aria-haspopup="true" aria-expanded="false" aria-label="หมวดของ ${escapeHtml(
              entry.title,
            )}"><span class="lbl">ไม่มีหมวด</span><span class="chev">${ICON_CHEVRON}</span></button>
            <div class="group-menu" hidden></div>
          </div>
          <div class="actions">
            <a class="primary" href="${href}">เปิด</a>
            <span class="grow"></span>
            <button class="iconbtn rename" type="button" data-id="${escapeHtml(
              entry.slug,
            )}" aria-label="แก้ชื่อ ${escapeHtml(entry.title)}" title="แก้ชื่อกระดาน">${ICON_PENCIL}<span>แก้ชื่อ</span></button>
            <a class="iconbtn" href="${download}" download aria-label="ดาวน์โหลด ${escapeHtml(
              entry.title,
            )}" title="ดาวน์โหลด">${ICON_DOWNLOAD}</a>
            <button class="iconbtn danger del" type="button" data-id="${escapeHtml(
              entry.slug,
            )}" aria-label="ลบ ${escapeHtml(entry.title)}" title="ลบ">${ICON_TRASH}<span>ลบ</span></button>
          </div>
        </div>
      </article>`;
    })
    .join("\n");

  // meta.json already knows whether any board sits in a group; with none the fold
  // button has nothing to fold, so it ships hidden and the API answer decides.
  const hasGroupHints = entries.some(
    (entry) => (Array.isArray(entry.groupIds) && entry.groupIds.length > 0) || entry.groupId,
  );

  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<link rel="icon" type="image/png" sizes="32x32" href="/gallery/logo-32.png">
<link rel="apple-touch-icon" sizes="180x180" href="/gallery/logo-180.png">
<meta name="theme-color" content="#f4f6ff">
<title>Excalidraw boards</title>
<script>
/* Runs before the first paint so a dark-theme visitor never sees the light page
   flash: the stored choice wins, otherwise the OS preference decides. */
try {
  var savedTheme = localStorage.getItem("boards-theme");
  if (savedTheme !== "dark" && savedTheme !== "light") {
    savedTheme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  document.documentElement.setAttribute("data-theme", savedTheme);
} catch (err) {
  document.documentElement.setAttribute("data-theme", "light");
}
</script>
<style>
  /* Every colour the page paints goes through a token, so the dark theme is a
     real palette rather than a filter: the light values below are unchanged. */
  :root {
    color-scheme: light;
    --bg: #eef1f8;
    --glow-a: rgba(139, 168, 255, 0.9);
    --glow-b: rgba(255, 148, 196, 0.78);
    --glow-c: rgba(121, 231, 195, 0.74);
    --glow-d: rgba(197, 212, 255, 0.58);
    --glow-e: rgba(255, 202, 228, 0.52);
    --panel: rgba(255, 255, 255, 0.56);
    --panel-strong: rgba(255, 255, 255, 0.78);
    --head-a: rgba(255, 255, 255, 0.58);
    --head-b: rgba(255, 255, 255, 0.32);
    --card-a: rgba(255, 255, 255, 0.42);
    --card-b: rgba(255, 255, 255, 0.22);
    --shot-a: rgba(255, 255, 255, 0.68);
    --shot-b: rgba(255, 255, 255, 0.32);
    --shot-line: rgba(255, 255, 255, 0.6);
    --chip-bg: rgba(255, 255, 255, 0.44);
    --chip-bg-hover: rgba(255, 255, 255, 0.78);
    --chip-line: rgba(255, 255, 255, 0.7);
    --ghost-bg: rgba(255, 255, 255, 0.48);
    --ghost-bg-hover: rgba(255, 255, 255, 0.76);
    --input-bg: rgba(255, 255, 255, 0.6);
    --input-bg-strong: rgba(255, 255, 255, 0.72);
    --input-inset: inset 0 1px 0 rgba(255, 255, 255, 0.7);
    --fallback-bg: rgba(250, 251, 255, 0.96);
    --bento-fade: rgba(250, 251, 255, 0.93);
    --line: rgba(24, 24, 39, 0.1);
    --line-strong: rgba(24, 24, 39, 0.16);
    --glass-line: rgba(255, 255, 255, 0.8);
    --ink: #18181f;
    --muted: #64646f;
    --accent: #6360d9;
    --accent-soft: rgba(99, 96, 217, 0.12);
    --ring: 0 0 0 3px rgba(99, 96, 217, 0.14);
    --btn-a: #7673e3;
    --btn-b: #6360d9;
    --btn-line: rgba(255, 255, 255, 0.3);
    --btn-inset: inset 0 1px 0 rgba(255, 255, 255, 0.28);
    --btn-glow: 0 6px 16px rgba(99, 96, 217, 0.25);
    --danger: #b42323;
    --danger-a: #cf3535;
    --danger-b: #b42323;
    --danger-line: #e8c2c2;
    --danger-line-soft: rgba(232, 194, 194, 0.9);
    --danger-bg: rgba(255, 240, 240, 0.4);
    --danger-bg-hover: rgba(255, 240, 240, 0.72);
    --hold-fill: rgba(255, 90, 90, 0.26);
    --scrim: rgba(24, 28, 48, 0.26);
    --modal-a: rgba(253, 254, 255, 0.95);
    --modal-b: rgba(247, 249, 255, 0.9);
    --modal-shadow: 0 26px 70px rgba(24, 30, 60, 0.24), inset 0 1px 0 rgba(255, 255, 255, 0.8);
    --card-shadow: 0 10px 30px rgba(31, 36, 71, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.7);
    --card-hover-shadow: 0 18px 42px rgba(31, 36, 71, 0.13), inset 0 1px 0 rgba(255, 255, 255, 0.78);
    --toast-bg: rgba(28, 30, 48, 0.9);
    --toast-ink: #f4f6ff;
    --blur: blur(20px) saturate(155%);
    --shadow: 0 12px 36px rgba(31, 36, 71, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.72);
    /* one dot colour per group; both sets stay ≥ 3:1 on their own backdrop */
    --g-violet: #6d5bd0;
    --g-blue: #2f6fd0;
    --g-teal: #0f8f7e;
    --g-amber: #a86a00;
    --g-rose: #c0345f;
    --g-slate: #59617a;
  }
  [data-theme="dark"] {
    color-scheme: dark;
    --bg: #0b0d16;
    --glow-a: rgba(74, 92, 200, 0.55);
    --glow-b: rgba(158, 62, 128, 0.42);
    --glow-c: rgba(30, 142, 122, 0.38);
    --glow-d: rgba(72, 96, 178, 0.34);
    --glow-e: rgba(142, 72, 122, 0.3);
    --panel: rgba(26, 30, 48, 0.62);
    --panel-strong: rgba(30, 35, 56, 0.85);
    --head-a: rgba(28, 32, 52, 0.85);
    --head-b: rgba(18, 21, 36, 0.66);
    --card-a: rgba(32, 37, 58, 0.74);
    --card-b: rgba(20, 23, 39, 0.56);
    --shot-a: rgba(255, 255, 255, 0.07);
    --shot-b: rgba(255, 255, 255, 0.02);
    --shot-line: rgba(255, 255, 255, 0.09);
    --chip-bg: rgba(255, 255, 255, 0.07);
    --chip-bg-hover: rgba(255, 255, 255, 0.15);
    --chip-line: rgba(255, 255, 255, 0.14);
    --ghost-bg: rgba(255, 255, 255, 0.06);
    --ghost-bg-hover: rgba(255, 255, 255, 0.13);
    --input-bg: rgba(255, 255, 255, 0.06);
    --input-bg-strong: rgba(255, 255, 255, 0.09);
    --input-inset: inset 0 1px 0 rgba(255, 255, 255, 0.05);
    --fallback-bg: rgba(20, 24, 40, 0.97);
    --bento-fade: rgba(16, 19, 33, 0.92);
    --line: rgba(226, 231, 255, 0.12);
    --line-strong: rgba(226, 231, 255, 0.2);
    --glass-line: rgba(255, 255, 255, 0.14);
    --ink: #eef0fa;
    --muted: #a8aec4;
    --accent: #918dff;
    --accent-soft: rgba(145, 141, 255, 0.22);
    --ring: 0 0 0 3px rgba(145, 141, 255, 0.28);
    --btn-a: #5d59d6;
    --btn-b: #4a46bf;
    --btn-line: rgba(255, 255, 255, 0.16);
    --btn-inset: inset 0 1px 0 rgba(255, 255, 255, 0.2);
    --btn-glow: 0 6px 18px rgba(10, 8, 40, 0.5);
    --danger: #ffa3a3;
    --danger-a: #c2413f;
    --danger-b: #9d2f2f;
    --danger-line: rgba(255, 122, 122, 0.42);
    --danger-line-soft: rgba(255, 122, 122, 0.34);
    --danger-bg: rgba(255, 92, 92, 0.13);
    --danger-bg-hover: rgba(255, 92, 92, 0.22);
    --hold-fill: rgba(255, 92, 92, 0.3);
    --scrim: rgba(3, 5, 12, 0.62);
    --modal-a: rgba(30, 35, 56, 0.96);
    --modal-b: rgba(17, 20, 33, 0.94);
    --modal-shadow: 0 26px 70px rgba(0, 0, 0, 0.62), inset 0 1px 0 rgba(255, 255, 255, 0.08);
    --card-shadow: 0 10px 30px rgba(0, 0, 0, 0.42), inset 0 1px 0 rgba(255, 255, 255, 0.06);
    --card-hover-shadow: 0 18px 42px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.1);
    --toast-bg: rgba(238, 241, 255, 0.96);
    --toast-ink: #14161f;
    --shadow: 0 12px 36px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.06);
    --g-violet: #b3a6ff;
    --g-blue: #85b3ff;
    --g-teal: #57d9c4;
    --g-amber: #f0c274;
    --g-rose: #ff93b0;
    --g-slate: #a9b3cc;
  }
  html { background: var(--bg); }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    padding: 22px 22px 44px;
    background:
      radial-gradient(900px 700px at 6% -8%, var(--glow-a) 0%, transparent 62%),
      radial-gradient(820px 640px at 102% -2%, var(--glow-b) 0%, transparent 60%),
      radial-gradient(920px 760px at 52% 112%, var(--glow-c) 0%, transparent 62%),
      radial-gradient(760px 560px at 26% 48%, var(--glow-d) 0%, transparent 72%),
      radial-gradient(760px 560px at 78% 62%, var(--glow-e) 0%, transparent 72%),
      var(--bg);
    background-attachment: fixed;
    color: var(--ink);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans Thai", Inter, system-ui, sans-serif;
  }
  header {
    position: sticky; top: 12px; z-index: 20;
    max-width: 1180px; margin: 0 auto 20px; padding: 9px 11px;
    border: 1px solid var(--glass-line); border-radius: 16px;
    background: linear-gradient(180deg, var(--head-a), var(--head-b));
    backdrop-filter: var(--blur); -webkit-backdrop-filter: var(--blur);
    box-shadow: var(--shadow);
  }
  .top { display: flex; flex-wrap: wrap; align-items: center; gap: 9px; }
  h1 { margin: 0; font-size: 19px; font-weight: 600; letter-spacing: -0.3px; }
  .brand {
    width: 30px; height: 30px; flex: none;
    filter: drop-shadow(0 1px 2px rgba(12, 16, 35, .28));
  }
  .count { color: var(--muted); font-size: 12.5px; white-space: nowrap; }
  .grow { flex: 1; }
  input[type="search"], button.card-group {
    color: var(--ink); background: var(--input-bg);
    border: 1px solid var(--glass-line); outline: none;
    box-shadow: var(--input-inset);
  }
  input[type="search"] {
    width: 220px; max-width: 100%; padding: 7px 11px; font: inherit; font-size: 13px;
    border-radius: 9px;
  }
  input[type="search"]::placeholder { color: var(--muted); }
  input[type="search"]:focus { border-color: var(--accent); box-shadow: var(--ring); }
  .app-link {
    color: #fff; text-decoration: none; white-space: nowrap;
    background: linear-gradient(180deg, var(--btn-a), var(--btn-b));
    border: 1px solid var(--btn-line);
    padding: 7px 12px; border-radius: 9px; font-size: 12.5px;
    box-shadow: var(--btn-glow), var(--btn-inset);
  }
  .app-link:hover { filter: brightness(.96); }
  .themebtn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 30px; height: 30px; padding: 0; line-height: 1; font-size: 14px; cursor: pointer;
    border-radius: 9px; border: 1px solid var(--chip-line);
    background: var(--chip-bg); color: var(--ink);
  }
  .themebtn:hover { background: var(--chip-bg-hover); border-color: var(--accent); }
  .themebtn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  #boards { max-width: 1180px; margin: 0 auto; }
  .grid {
    display: grid; gap: 15px;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  }
  /* --- groups: second header row, filter chips, section headings --------- */
  #groupbar {
    display: flex; align-items: center; flex-wrap: wrap; gap: 7px;
    margin-top: 9px; padding-top: 9px; border-top: 1px solid var(--line);
  }
  #groupbar[hidden] { display: none; }
  #group-chips { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
  .chip {
    display: inline-flex; align-items: center; gap: 6px; height: 27px; padding: 0 10px;
    border-radius: 999px; cursor: pointer; white-space: nowrap;
    border: 1px solid var(--chip-line); background: var(--chip-bg); color: var(--ink);
    font: inherit; font-size: 11.5px;
    transition: background .12s ease, border-color .12s ease;
  }
  .chip:hover { background: var(--chip-bg-hover); border-color: var(--accent); }
  .chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .chip[aria-pressed="true"] { background: var(--accent-soft); border-color: var(--accent); font-weight: 600; }
  .chip .n { color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; font-weight: 400; }
  .chip[aria-pressed="true"] .n { color: var(--accent); }
  #group-new {
    display: inline-flex; align-items: center; gap: 4px; height: 27px; padding: 0 10px;
    border-radius: 999px; cursor: pointer; font: inherit; font-size: 11.5px;
    border: 1px dashed var(--line-strong); background: transparent; color: var(--muted);
  }
  #group-new:hover { color: var(--ink); border-color: var(--accent); background: var(--chip-bg); }
  #group-new:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .dot {
    width: 8px; height: 8px; border-radius: 50%; flex: none;
    background: var(--g-slate); box-shadow: 0 0 0 1px var(--glass-line);
  }
  .dot.violet { background: var(--g-violet); }
  .dot.blue { background: var(--g-blue); }
  .dot.teal { background: var(--g-teal); }
  .dot.amber { background: var(--g-amber); }
  .dot.rose { background: var(--g-rose); }
  .dot.slate { background: var(--g-slate); }
  #sections { display: flex; flex-direction: column; gap: 22px; }
  .board-section[hidden] { display: none; }
  .sect-head { display: flex; align-items: center; gap: 8px; margin: 0 0 10px; padding: 0 2px; min-height: 24px; }
  .sect-head h2 { margin: 0; font-size: 13px; font-weight: 600; letter-spacing: .1px; }
  .sect-count { color: var(--muted); font-size: 11.5px; font-variant-numeric: tabular-nums; }
  .sect-head h2 + .sect-count { margin-right: 2px; }
  /* หมวดหุบ/กางได้: ลูกศรหมุน 90° แล้วกริดของหมวดนั้นซ่อน แต่หัวข้อยังอยู่ */
  .sect-toggle {
    display: inline-flex; align-items: center; justify-content: center;
    width: 21px; height: 21px; padding: 0; margin-left: -3px; border-radius: 6px;
    border: 1px solid transparent; background: transparent; color: var(--muted);
    cursor: pointer; transition: transform .16s ease, background .12s ease, color .12s ease;
  }
  .sect-toggle:hover { background: var(--chip-bg-hover); color: var(--ink); }
  .sect-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .board-section[data-collapsed="1"] .sect-toggle { transform: rotate(-90deg); }
  .board-section[data-collapsed="1"] .grid { display: none; }
  /* การค้นหาต้องโชว์ของที่เจอเสมอ แม้หมวดนั้นจะถูกหุบไว้ */
  #sections.searching .board-section[data-collapsed="1"] .grid { display: grid; }
  .sect-btn {
    font: inherit; font-size: 11px; padding: 3px 8px; cursor: pointer; border-radius: 7px;
    border: 1px solid var(--line-strong); background: var(--ghost-bg); color: var(--muted);
  }
  .sect-btn:hover { color: var(--ink); border-color: var(--accent); background: var(--ghost-bg-hover); }
  .sect-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .sect-btn.danger:hover { color: var(--danger); border-color: var(--danger); background: var(--danger-bg-hover); }
  /* หมวดของกระดาน: a compact multi-select. The trigger keeps the old
     .card-group class so existing selectors/CSS still find it; the menu sits in
     the card's flow, so on a 393px screen it can never poke out sideways or be
     clipped by the rounded card. */
  .group-pick { position: relative; margin-top: 8px; min-width: 0; }
  .group-pick[hidden] { display: none; }
  button.card-group {
    display: flex; align-items: center; justify-content: space-between; gap: 6px;
    width: 100%; min-width: 0; font: inherit; font-size: 11.5px; padding: 4px 7px;
    border-radius: 8px; border-color: var(--line-strong); cursor: pointer; text-align: left;
  }
  button.card-group:hover { border-color: var(--accent); }
  button.card-group:focus-visible { border-color: var(--accent); box-shadow: var(--ring); outline: 2px solid var(--accent); outline-offset: 1px; }
  button.card-group[aria-expanded="true"] { border-color: var(--accent); box-shadow: var(--ring); }
  .card-group .lbl { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card-group .chev { display: inline-flex; flex: none; transition: transform .14s ease; }
  .card-group[aria-expanded="true"] .chev { transform: rotate(180deg); }
  .group-menu {
    display: flex; flex-direction: column; gap: 1px; margin-top: 5px; padding: 4px;
    border: 1px solid var(--line-strong); border-radius: 9px;
    background: var(--input-bg-strong); box-shadow: var(--input-inset);
    max-height: 190px; overflow: auto; overscroll-behavior: contain;
  }
  .group-menu[hidden] { display: none; }
  .group-menu label {
    display: flex; align-items: center; gap: 7px; padding: 4px 6px; border-radius: 6px;
    font-size: 11.5px; color: var(--ink); cursor: pointer;
  }
  .group-menu label:hover { background: var(--accent-soft); }
  .group-menu input[type="checkbox"] {
    width: 13px; height: 13px; margin: 0; flex: none; accent-color: var(--accent); cursor: pointer;
  }
  .group-menu input[type="checkbox"]:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .group-menu .group-clear {
    font: inherit; font-size: 11px; text-align: left; margin-top: 3px; padding: 5px 6px;
    border: 1px dashed var(--line-strong); border-radius: 6px;
    background: transparent; color: var(--muted); cursor: pointer;
  }
  .group-menu .group-clear:hover { color: var(--danger); border-color: var(--danger); background: var(--danger-bg); }
  .group-menu .group-clear:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .card {
    display: flex; flex-direction: column; overflow: hidden;
    background: linear-gradient(180deg, var(--card-a), var(--card-b));
    backdrop-filter: var(--blur); -webkit-backdrop-filter: var(--blur);
    border: 1px solid var(--glass-line); border-radius: 16px;
    box-shadow: var(--card-shadow);
    transition: border-color .14s ease, transform .14s ease, box-shadow .14s ease;
  }
  /* .card sets display:flex, which would otherwise override the hidden attribute
     and make the search box look broken (cards stayed on screen). */
  .card[hidden] { display: none; }
  .card:hover {
    border-color: color-mix(in srgb, var(--accent) 32%, var(--glass-line));
    transform: translateY(-2px);
    box-shadow: var(--card-hover-shadow);
  }
  .shot {
    display: flex; align-items: center; justify-content: center; text-decoration: none;
    aspect-ratio: 16 / 10; padding: 10px; overflow: hidden;
    background: linear-gradient(180deg, var(--shot-a), var(--shot-b));
    border-bottom: 1px solid var(--shot-line);
  }
  .shot img { max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; }
  .placeholder { color: var(--muted); font-size: 12px; }
  .body { display: flex; flex-direction: column; gap: 3px; padding: 12px 13px 13px; }
  /* long board names should wrap inside the card, not get sliced at its edge */
  h2 { margin: 0; font-size: 14.5px; font-weight: 600; line-height: 1.35; overflow-wrap: anywhere; }
  .sub { margin: 0; color: var(--muted); font-size: 12px; }
  .meta {
    margin: 0; color: var(--muted); font-size: 11.5px; line-height: 1.45;
    font-variant-numeric: tabular-nums; overflow-wrap: anywhere;
  }
  .actions { display: flex; align-items: center; gap: 6px; margin-top: 10px; }
  .primary {
    display: inline-flex; align-items: center; text-decoration: none;
    background: linear-gradient(180deg, var(--btn-a), var(--btn-b));
    color: #fff; font-size: 12.5px; padding: 5px 12px; border-radius: 8px;
    border: 1px solid var(--btn-line);
    box-shadow: var(--btn-glow), var(--btn-inset);
  }
  .primary:hover { filter: brightness(.96); }
  button.primary { font: inherit; font-size: 12.5px; cursor: pointer; padding: 7px 13px; border-radius: 9px; }
  .iconbtn {
    display: inline-flex; align-items: center; justify-content: center; gap: 4px;
    height: 28px; padding: 0 7px; border-radius: 8px; cursor: pointer;
    border: 1px solid var(--chip-line);
    background: var(--chip-bg);
    color: var(--muted);
    font: inherit; font-size: 12px; text-decoration: none;
    opacity: .84; transition: opacity .12s ease, border-color .12s ease, color .12s ease, background .12s ease;
  }
  .card:hover .iconbtn, .card:focus-within .iconbtn { opacity: 1; }
  .iconbtn:hover { background: var(--chip-bg-hover); border-color: var(--accent); color: var(--ink); }
  .iconbtn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; opacity: 1; }
  .iconbtn.rename span { display: inline; }
  .iconbtn.danger { color: var(--danger); border-color: var(--danger-line-soft); background: var(--danger-bg); }
  .iconbtn.danger:hover { border-color: var(--danger); background: var(--danger-bg-hover); }
  .iconbtn:disabled { opacity: .4; cursor: default; }
  @media (hover: none) {
    .iconbtn { opacity: 1; }
  }
  /* ------------------------------------------------------- view switch ----- */
  .view-switch {
    display: inline-flex; align-items: center; gap: 2px; padding: 2px;
    border-radius: 10px; border: 1px solid var(--chip-line); background: var(--chip-bg);
  }
  .view-btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 28px; height: 24px; padding: 0; cursor: pointer;
    border: 1px solid transparent; border-radius: 8px;
    background: transparent; color: var(--muted);
    transition: background .12s ease, color .12s ease, border-color .12s ease;
  }
  .view-btn:hover { color: var(--ink); background: var(--chip-bg-hover); }
  .view-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  /* the active pill follows <body data-view>, which the pre-paint script sets,
     so the switch is already correct on the very first frame */
  body[data-view="card"] .view-btn[data-view="card"],
  body[data-view="list"] .view-btn[data-view="list"],
  body[data-view="bento"] .view-btn[data-view="bento"] {
    color: var(--ink); background: var(--accent-soft); border-color: var(--accent);
  }
  /* -------------------------------------------------- collapsible group bar - */
  .bar-toggle {
    position: relative; display: inline-flex; align-items: center; justify-content: center;
    width: 30px; height: 30px; padding: 0; cursor: pointer;
    border-radius: 9px; border: 1px solid var(--chip-line);
    background: var(--chip-bg); color: var(--ink);
    transition: background .12s ease, border-color .12s ease, color .12s ease;
  }
  .bar-toggle:hover { background: var(--chip-bg-hover); border-color: var(--accent); }
  .bar-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .bar-toggle[hidden] { display: none; }
  .bar-toggle .chev { display: inline-flex; transition: transform .18s ease; }
  header[data-bar="folded"] .bar-toggle .chev,
  html[data-bar="folded"] .bar-toggle .chev { transform: rotate(180deg); }
  /* html[data-bar] is the pre-paint hook: it hides the bar before the header's
     own script state exists, so a folded bar never flashes on load */
  header[data-bar="folded"] #groupbar,
  html[data-bar="folded"] #groupbar { display: none; }
  /* still filtering by a group while the bar is folded: a dot says so */
  .bar-toggle[data-filter="1"] { border-color: var(--accent); color: var(--accent); }
  .bar-toggle[data-filter="1"]::after {
    content: ""; position: absolute; top: 4px; right: 4px; width: 6px; height: 6px;
    border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 2px var(--panel-strong);
  }
  .bar-summary {
    display: inline-flex; align-items: center; min-width: 0; max-width: 190px;
    padding: 4px 9px; border-radius: 999px; font-size: 11.5px; color: var(--muted);
    border: 1px solid var(--chip-line); background: var(--chip-bg);
  }
  .bar-summary[hidden] { display: none; }
  .bar-summary .txt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* --------------------------------------------------------- list view ----- */
  body[data-view="list"] .grid { display: flex; flex-direction: column; gap: 10px; }
  body[data-view="list"] .card { flex-direction: row; align-items: center; border-radius: 14px; }
  body[data-view="list"] .shot {
    flex: 0 0 132px; width: 132px; height: 86px; aspect-ratio: auto; padding: 6px;
    border-bottom: 0; border-right: 1px solid var(--shot-line);
    border-radius: 13px 0 0 13px;
  }
  body[data-view="list"] .body {
    flex: 1 1 auto; min-width: 0;
    display: grid; align-items: center; row-gap: 2px; column-gap: 16px; padding: 10px 13px;
    grid-template-columns: minmax(0, 1fr) auto auto auto;
    grid-template-areas:
      "title meta pick actions"
      "sub meta pick actions";
  }
  body[data-view="list"] .body h2 { grid-area: title; }
  body[data-view="list"] .sub { grid-area: sub; }
  body[data-view="list"] .meta { grid-area: meta; max-width: none; }
  body[data-view="list"] .group-pick { grid-area: pick; margin-top: 0; min-width: 118px; max-width: 190px; }
  body[data-view="list"] .actions { grid-area: actions; margin-top: 0; flex-wrap: nowrap; }
  /* -------------------------------------------------------- bento view ----- */
  body[data-view="bento"] .grid {
    grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
    grid-auto-rows: 132px;
    grid-auto-flow: dense;
  }
  body[data-view="bento"] .card { position: relative; overflow: visible; border-radius: 15px; }
  body[data-view="bento"] .card .shot {
    position: absolute; inset: 0; z-index: -1; aspect-ratio: auto; padding: 0;
    border-bottom: 0; border-radius: 15px;
  }
  /* a bento tile is a picture: the preview covers the whole tile and the words
     sit on a frosted strip at its foot, with the group pick floating in the
     opposite corner so the strip only has to hold the name and the buttons.
     The card's backdrop-filter makes a stacking context, so the negative z-index
     keeps the picture under the flow without taking .body out of it — that way
     the pick can anchor to the tile itself. */
  body[data-view="bento"] .card .shot img {
    width: 100%; height: 100%; max-width: none; max-height: none; object-fit: cover;
  }
  body[data-view="bento"] .card .body {
    margin-top: auto; padding: 20px 10px 8px;
    border-radius: 0 0 15px 15px;
    display: grid; align-items: center; column-gap: 6px;
    grid-template-columns: minmax(0, 1fr) auto;
    background: linear-gradient(180deg, transparent 0, var(--bento-fade) 20px, var(--bento-fade) 100%);
  }
  body[data-view="bento"] .card .body h2 {
    grid-area: 1 / 1 / 2 / 2; font-size: 13px; line-height: 1.3;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  body[data-view="bento"] .card .sub,
  body[data-view="bento"] .card .meta { display: none; }
  body[data-view="bento"] .card[data-weight="large"] .meta {
    display: block; grid-area: 2 / 1 / 3 / 3; margin-top: 3px; font-size: 10.5px;
  }
  body[data-view="bento"] .card .group-pick {
    position: absolute; top: 8px; right: 8px; z-index: 2;
    margin: 0; min-width: 0; max-width: calc(100% - 16px);
  }
  body[data-view="bento"] button.card-group {
    /* the chip floats over the picture, so it needs a solid backing of its own */
    width: auto; max-width: 100%; padding: 3px 7px; font-size: 10.5px; border-radius: 7px;
    background: var(--bento-fade); border-color: var(--line-strong);
  }
  body[data-view="bento"] .group-menu {
    position: absolute; right: 0; left: auto; top: calc(100% + 6px); width: 172px;
    margin-top: 0; z-index: 8; box-shadow: var(--card-hover-shadow);
  }
  /* the open menu hangs past the tile, so that tile has to sit above its neighbours */
  body[data-view="bento"] .card:has(button.card-group[aria-expanded="true"]) { z-index: 9; }
  body[data-view="bento"] .card .actions {
    grid-area: 1 / 2 / 2 / 3; margin-top: 0; gap: 4px; flex-wrap: nowrap;
  }
  body[data-view="bento"] .card .actions .primary,
  body[data-view="bento"] .card .actions .grow { display: none; }
  body[data-view="bento"] .card .iconbtn { height: 25px; padding: 0 6px; }
  body[data-view="bento"] .card .iconbtn span { display: none; }
  body[data-view="bento"] .card[data-weight="large"] { grid-column: span 2; grid-row: span 2; }
  body[data-view="bento"] .card[data-weight="wide"] { grid-column: span 2; }
  body[data-view="bento"] .card[data-weight="tall"] { grid-row: span 2; }
  /* the new .grid rules tie the collapse rule on specificity but come later, so
     a collapsed section has to be re-hidden explicitly in both views */
  body[data-view="list"] .board-section[data-collapsed="1"] .grid,
  body[data-view="bento"] .board-section[data-collapsed="1"] .grid { display: none; }
  body[data-view="list"] #sections.searching .board-section[data-collapsed="1"] .grid { display: flex; }
  body[data-view="bento"] #sections.searching .board-section[data-collapsed="1"] .grid { display: grid; }
  /* narrow screens: keep the title row for title + actions, give search its own row */
  @media (max-width: 520px) {
    .top > .grow { display: none; }
    #count { order: 1; }
    #bar-toggle { order: 2; }
    #view-switch { order: 3; }
    #theme-toggle { order: 4; margin-left: auto; }
    .bar-summary { display: none; }
    .app-link { order: 5; }
    input[type="search"] { order: 6; flex: 1 1 100%; width: 100%; }
  }
  /* list rows on a narrow screen: smaller thumbnail, text stacked next to the actions */
  @media (max-width: 640px) {
    /* a phone row has no room for a side column, so the text stacks under the
       title and the actions keep the full width of the body */
    body[data-view="list"] .shot { flex: 0 0 96px; width: 96px; height: 64px; padding: 5px; align-self: center; }
    body[data-view="list"] .body {
      display: flex; flex-direction: column; align-items: stretch;
      gap: 3px; padding: 9px 11px;
    }
    body[data-view="list"] .meta { max-width: none; }
    body[data-view="list"] .actions { margin-top: 6px; flex-wrap: wrap; }
    body[data-view="list"] .group-pick { min-width: 0; max-width: 100%; margin-top: 6px; }
  }
  /* bento on a phone: one column, and the tile falls back to a stacked card */
  @media (max-width: 520px) {
    body[data-view="bento"] .grid { grid-template-columns: 1fr; grid-auto-rows: auto; grid-auto-flow: row; }
    body[data-view="bento"] .card,
    body[data-view="bento"] .card[data-weight="large"],
    body[data-view="bento"] .card[data-weight="wide"],
    body[data-view="bento"] .card[data-weight="tall"] { grid-column: auto; grid-row: auto; }
    body[data-view="bento"] .card .shot {
      position: static; inset: auto; z-index: auto; aspect-ratio: 16 / 10; padding: 0;
      border-radius: 15px 15px 0 0;
    }
    body[data-view="bento"] .card .body {
      display: flex; flex-direction: column; align-items: stretch; gap: 3px;
      margin-top: 0; padding: 12px 13px 13px; border-radius: 0 0 15px 15px; background: none;
    }
    /* the tile is a stacked card again, so the pick goes back into the flow */
    body[data-view="bento"] .card .group-pick {
      position: static; top: auto; right: auto; max-width: 100%; margin-top: 8px;
    }
    body[data-view="bento"] .group-menu {
      position: static; top: auto; left: auto; right: auto; width: auto; margin-top: 5px;
      box-shadow: var(--input-inset);
    }
    body[data-view="bento"] .card .body h2 { display: block; font-size: 14.5px; }
    body[data-view="bento"] .card .sub,
    body[data-view="bento"] .card .meta,
    body[data-view="bento"] .card[data-weight="large"] .meta { display: block; grid-column: auto; }
    body[data-view="bento"] .card .group-pick { grid-column: auto; }
    body[data-view="bento"] .card .actions { grid-column: auto; }
    body[data-view="bento"] .card .actions .primary { display: inline-flex; }
    body[data-view="bento"] .card .actions .grow { display: block; }
  }
  @media (max-width: 560px) {
    .sect-toggle { width: 26px; height: 26px; margin-left: -5px; }
  }
  @media (max-width: 420px) {
    .iconbtn.rename span, .iconbtn.danger span { display: none; }
    .sect-btn { padding: 3px 6px; font-size: 10.5px; }
  }
  .modal {
    position: fixed; inset: 0; z-index: 50; display: grid; place-items: center;
    background: var(--scrim);
    backdrop-filter: blur(7px); -webkit-backdrop-filter: blur(7px);
    padding: 20px;
  }
  .modal[hidden] { display: none; }
  .modal-card {
    width: min(420px, 100%); max-height: calc(100vh - 40px); overflow: auto;
    background: linear-gradient(180deg, var(--modal-a), var(--modal-b));
    backdrop-filter: var(--blur); -webkit-backdrop-filter: var(--blur);
    border: 1px solid var(--glass-line); border-radius: 18px; padding: 20px 20px 15px;
    box-shadow: var(--modal-shadow);
  }
  .modal-card h2 { margin: 0 0 8px; font-size: 16px; }
  .modal-card p { margin: 0 0 16px; font-size: 12.5px; line-height: 1.55; color: var(--muted); }
  .modal-actions { display: flex; justify-content: flex-end; align-items: center; gap: 8px; }
  .field { display: flex; flex-direction: column; gap: 6px; margin: 0 0 14px; }
  .field span { font-size: 11.5px; color: var(--muted); }
  .field input {
    width: 100%; padding: 8px 10px; font: inherit; font-size: 13.5px;
    color: var(--ink); background: var(--input-bg-strong);
    border: 1px solid var(--line-strong); border-radius: 9px; outline: none;
    box-shadow: var(--input-inset);
  }
  .field input:focus { border-color: var(--accent); box-shadow: var(--ring); }
  .colors { display: flex; gap: 8px; flex-wrap: wrap; border: 0; margin: 0 0 15px; padding: 0; min-width: 0; }
  .colors legend { font-size: 11.5px; color: var(--muted); padding: 0 0 7px; }
  .swatch { position: relative; display: inline-flex; cursor: pointer; }
  .swatch input { position: absolute; inset: 0; margin: 0; opacity: 0; cursor: pointer; }
  .swatch span {
    display: block; width: 25px; height: 25px; border-radius: 50%;
    background: var(--sw); border: 1px solid var(--line-strong);
  }
  .swatch input:checked + span { box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--sw); }
  .swatch input:focus-visible + span { outline: 2px solid var(--accent); outline-offset: 3px; }
  .dangerbtn {
    font: inherit; font-size: 12.5px; cursor: pointer; padding: 7px 13px; border-radius: 9px;
    color: #fff; background: linear-gradient(180deg, var(--danger-a), var(--danger-b));
    border: 1px solid var(--btn-line);
    box-shadow: var(--btn-glow), var(--btn-inset);
  }
  .dangerbtn:hover { filter: brightness(.96); }
  .dangerbtn:disabled { opacity: .6; cursor: default; filter: none; }
  .modal-note { margin: -4px 0 12px !important; font-size: 12px !important; color: var(--danger) !important; }
  .ghost {
    font: inherit; font-size: 12.5px; padding: 7px 12px; cursor: pointer;
    border-radius: 9px; border: 1px solid var(--line-strong);
    background: var(--ghost-bg); color: var(--ink);
  }
  .ghost:hover { border-color: var(--accent); background: var(--ghost-bg-hover); }
  .modal-hint { margin: 12px 0 0 !important; font-size: 11.5px !important; color: var(--muted) !important; text-align: right; }
  .holdbtn {
    position: relative; overflow: hidden; min-width: 168px; justify-content: center;
    display: inline-flex; align-items: center; padding: 7px 14px; border-radius: 9px;
    border: 1px solid var(--danger-line); background: var(--danger-bg); color: var(--danger);
    font: inherit; font-size: 12.5px; cursor: pointer; user-select: none; touch-action: none;
  }
  .holdbtn .fill {
    position: absolute; left: 0; top: 0; bottom: 0; width: 0; pointer-events: none;
    background: var(--hold-fill);
  }
  .holdbtn .lbl { position: relative; }
  .holdbtn:disabled { cursor: default; }
  footer {
    max-width: 1180px; margin: 26px auto 0; color: var(--muted); font-size: 11px;
  }
  .empty { max-width: 1180px; margin: 38px auto; color: var(--muted); font-size: 13px; }
  #toast {
    position: fixed; left: 50%; bottom: 22px; z-index: 60;
    transform: translateX(-50%) translateY(8px);
    max-width: min(420px, calc(100% - 32px)); padding: 9px 14px; border-radius: 11px;
    font-size: 12.5px; line-height: 1.4; color: var(--toast-ink);
    background: var(--toast-bg); border: 1px solid var(--glass-line);
    box-shadow: var(--modal-shadow);
    backdrop-filter: var(--blur); -webkit-backdrop-filter: var(--blur);
    opacity: 0; pointer-events: none;
    transition: opacity .16s ease, transform .16s ease;
  }
  #toast[hidden] { display: none; }
  #toast.on { opacity: 1; transform: translateX(-50%) translateY(0); }
  @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
    header, .card, .modal-card { background: var(--fallback-bg); }
  }
</style>
</head>
<body data-view="card">
<script>
/* Runs before the first paint: the saved layout and a folded group bar are
   already right on the first frame, so nothing jumps once the page settles. */
try {
  var savedView = localStorage.getItem("boards-view");
  document.body.dataset.view = savedView === "list" || savedView === "bento" ? savedView : "card";
} catch (err) {
  document.body.dataset.view = "card";
}
try {
  if (localStorage.getItem("boards-bar") === "folded") {
    document.documentElement.setAttribute("data-bar", "folded");
  }
} catch (err) {}
</script>
<header>
  <div class="top">
    <img class="brand" src="/gallery/logo-64.png" alt="" width="30" height="30" decoding="async">
    <h1>Boards</h1>
    <span class="count" id="count">${entries.length} board${entries.length === 1 ? "" : "s"}</span>
    <span class="grow"></span>
    <input type="search" id="q" placeholder="ค้นหากระดาน…" aria-label="ค้นหากระดาน" autocomplete="off" spellcheck="false">
    <button type="button" id="bar-toggle" class="bar-toggle" aria-expanded="true" aria-controls="groupbar" title="ย่อหมวดหมู่" aria-label="ย่อหมวดหมู่"${hasGroupHints ? "" : " hidden"}><span class="chev">${ICON_CHEVRON}</span></button>
    <span id="bar-summary" class="bar-summary" hidden aria-live="polite"><span class="txt"></span></span>
    <div id="view-switch" class="view-switch" role="radiogroup" aria-label="รูปแบบการแสดงผล">
      <button type="button" class="view-btn" data-view="card" role="radio" aria-checked="true" title="การ์ด" tabindex="0">${ICON_VIEW_CARD}</button>
      <button type="button" class="view-btn" data-view="list" role="radio" aria-checked="false" title="รายการ" tabindex="-1">${ICON_VIEW_LIST}</button>
      <button type="button" class="view-btn" data-view="bento" role="radio" aria-checked="false" title="เบนโต" tabindex="-1">${ICON_VIEW_BENTO}</button>
    </div>
    <button class="themebtn" type="button" id="theme-toggle" aria-label="สลับเป็นโหมดมืด" title="สลับธีม"><span class="theme-glyph" aria-hidden="true">☾</span></button>
    <a class="app-link" href="/new">+ กระดานใหม่</a>
  </div>
  <div id="groupbar" hidden>
    <div id="group-chips" role="group" aria-label="กรองตามหมวดหมู่"></div>
    <button id="group-new" type="button">+ หมวดใหม่</button>
  </div>
</header>
<main id="boards">
<div id="sections">
<div class="grid" id="grid">
${cards}
</div>
</div>
</main>
${entries.length === 0 ? '<p class="empty" id="no-boards">ยังไม่มีกระดานในเซิร์ฟเวอร์นี้ — กด “+ กระดานใหม่” เพื่อเริ่ม</p>' : ""}
<p class="empty" id="empty" hidden>ไม่พบกระดานที่ตรงกับชื่อนี้</p>
<footer>อัปเดต ${escapeHtml(generatedAt)}</footer>
<div class="modal" id="del-modal" hidden>
  <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="del-title">
    <h2 id="del-title">ลบกระดานนี้?</h2>
    <p id="del-detail"></p>
    <div class="modal-actions">
      <button class="ghost" type="button" id="del-cancel">ยกเลิก</button>
      <button class="holdbtn" type="button" id="del-hold">
        <span class="fill"></span><span class="lbl">กดค้างเพื่อลบ</span>
      </button>
    </div>
    <p class="modal-hint">กดปุ่มค้างไว้ประมาณ 1 วินาทีเพื่อยืนยัน</p>
  </div>
</div>
<div class="modal" id="rename-modal" hidden>
  <form class="modal-card" id="rename-form" role="dialog" aria-modal="true" aria-labelledby="rename-title" novalidate>
    <h2 id="rename-title">แก้ชื่อกระดาน</h2>
    <p>ชื่อนี้จะแสดงในหน้ารวมและในหน้าแก้ไขทันที</p>
    <label class="field" for="rename-input">
      <span>ชื่อกระดาน</span>
      <input id="rename-input" maxlength="120" autocomplete="off" spellcheck="false" required>
    </label>
    <p class="modal-note" id="rename-note" hidden></p>
    <div class="modal-actions">
      <button class="ghost" type="button" id="rename-cancel">ยกเลิก</button>
      <button class="primary" type="submit" id="rename-save">บันทึกชื่อ</button>
    </div>
  </form>
</div>
<div class="modal" id="group-modal" hidden>
  <form class="modal-card" id="group-form" role="dialog" aria-modal="true" aria-labelledby="group-modal-title" novalidate>
    <h2 id="group-modal-title">หมวดใหม่</h2>
    <p id="group-modal-sub">ตั้งชื่อหมวดเพื่อจัดกลุ่มกระดานในหน้ารวมนี้</p>
    <label class="field" for="group-name">
      <span>ชื่อหมวด</span>
      <input id="group-name" maxlength="60" autocomplete="off" spellcheck="false" required>
    </label>
    <fieldset class="colors" id="group-colors">
      <legend>สีของหมวด</legend>
      <label class="swatch" title="ม่วง" style="--sw: var(--g-violet)"><input type="radio" name="group-color" value="violet" aria-label="ม่วง" checked><span></span></label>
      <label class="swatch" title="น้ำเงิน" style="--sw: var(--g-blue)"><input type="radio" name="group-color" value="blue" aria-label="น้ำเงิน"><span></span></label>
      <label class="swatch" title="เขียวน้ำทะเล" style="--sw: var(--g-teal)"><input type="radio" name="group-color" value="teal" aria-label="เขียวน้ำทะเล"><span></span></label>
      <label class="swatch" title="เหลืองอำพัน" style="--sw: var(--g-amber)"><input type="radio" name="group-color" value="amber" aria-label="เหลืองอำพัน"><span></span></label>
      <label class="swatch" title="ชมพู" style="--sw: var(--g-rose)"><input type="radio" name="group-color" value="rose" aria-label="ชมพู"><span></span></label>
      <label class="swatch" title="เทา" style="--sw: var(--g-slate)"><input type="radio" name="group-color" value="slate" aria-label="เทา"><span></span></label>
    </fieldset>
    <p class="modal-note" id="group-note" hidden></p>
    <div class="modal-actions">
      <button class="ghost" type="button" id="group-cancel">ยกเลิก</button>
      <button class="primary" type="submit" id="group-save">บันทึกหมวด</button>
    </div>
  </form>
</div>
<div class="modal" id="group-del-modal" hidden>
  <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="group-del-title">
    <h2 id="group-del-title">ลบหมวดนี้?</h2>
    <p id="group-del-detail"></p>
    <div class="modal-actions">
      <button class="ghost" type="button" id="group-del-cancel">ยกเลิก</button>
      <button class="dangerbtn" type="button" id="group-del-confirm">ลบหมวด</button>
    </div>
  </div>
</div>
<p id="toast" hidden></p>
<script>
  const q = document.getElementById("q");
  const boardsEl = document.getElementById("boards");
  const count = document.getElementById("count");
  const empty = document.getElementById("empty");
  const groupbar = document.getElementById("groupbar");
  const groupChips = document.getElementById("group-chips");
  const groupNew = document.getElementById("group-new");
  const toastEl = document.getElementById("toast");
  // the same glyphs the built page uses, so cards added at runtime look identical
  const ICONS = {
    download: ${JSON.stringify(ICON_DOWNLOAD)},
    trash: ${JSON.stringify(ICON_TRASH)},
    pencil: ${JSON.stringify(ICON_PENCIL)},
    chevron: ${JSON.stringify(ICON_CHEVRON)},
  };
  const COLORS = ["violet", "blue", "teal", "amber", "rose", "slate"];
  const NONE_KEY = "__none__";
  // กรองด้วยชิป: "all" = ทุกหมวด, otherwise a group id
  let activeGroup = "all";
  let groups = [];
  /* board slug -> ordered group ids it belongs to (missing/[] = ไม่มีหมวดหมู่).
     /api/groups + /api/boards groupIds win over the data-groups hint the build
     wrote into each card. */
  const membership = new Map();
  /* one master card per board: every section shows a clone, because one DOM node
     cannot stand in two places and a board may now belong to several groups.
     data-slug stays the board identity on every copy. */
  const prototypes = new Map();
  /* The one open group menu, remembered across layout(): a tick rebuilds the
     sections, and the menu must stay open under the pointer for the next tick. */
  let openMenu = null;

  /* ซึ่งหมวดที่ผู้ใช้หุบไว้ — จำใน localStorage เพื่อให้เปิดหน้ามาแล้วยังหุบอยู่ */
  const COLLAPSE_KEY = "boards-collapsed";
  const collapsed = (() => {
    try {
      const raw = JSON.parse(window.localStorage.getItem(COLLAPSE_KEY) || "[]");
      return new Set(Array.isArray(raw) ? raw.filter((key) => typeof key === "string") : []);
    } catch (error) {
      return new Set();
    }
  })();

  function saveCollapsed() {
    try {
      window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed]));
    } catch (error) {
      /* private mode: ยังหุบ/กางได้ในหน้านี้ */
    }
  }

  function collapsedNow(section) {
    return collapsed.has(section.dataset.group);
  }

  function applyCollapsed(section) {
    const on = collapsedNow(section);
    section.dataset.collapsed = on ? "1" : "0";
    const toggle = section.querySelector(".sect-toggle");
    if (toggle) {
      toggle.setAttribute("aria-expanded", on ? "false" : "true");
      toggle.title = on ? "กางหมวดนี้" : "หุบหมวดนี้";
      toggle.setAttribute("aria-label", (on ? "กางหมวด " : "หุบหมวด ") + (section.dataset.name || ""));
    }
  }

  function toggleSection(section) {
    const key = section.dataset.group;
    if (collapsed.has(key)) collapsed.delete(key);
    else collapsed.add(key);
    saveCollapsed();
    applyCollapsed(section);
  }

  function safeId(id) {
    return window.CSS && CSS.escape ? CSS.escape(String(id)) : String(id).replace(/"/g, '\\"');
  }

  function cards() {
    return [...boardsEl.querySelectorAll(".card")];
  }

  function cardsFor(slug) {
    return [...boardsEl.querySelectorAll('.card[data-slug="' + safeId(slug) + '"]')];
  }

  function cardTitle(slug) {
    const proto = prototypes.get(slug);
    const h2 = proto && proto.querySelector("h2");
    return h2 ? h2.textContent : slug;
  }

  function groupById(id) {
    for (const group of groups) if (group.id === id) return group;
    return null;
  }

  /* a board's memberships, filtered to groups that still exist and de-duped */
  function groupsOf(slug) {
    const raw = membership.get(slug);
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const id of raw) {
      if (id && groupById(id) && !out.includes(id)) out.push(id);
    }
    return out;
  }

  function groupOf(slug) {
    const own = groupsOf(slug);
    return own.length ? own[0] : "";
  }

  function countIn(groupId) {
    let n = 0;
    for (const slug of prototypes.keys()) if (groupsOf(slug).includes(groupId)) n += 1;
    return n;
  }

  function menuLabel(ids) {
    if (!ids.length) return "ไม่มีหมวด";
    if (ids.length === 1) {
      const group = groupById(ids[0]);
      return group ? group.name : "ไม่มีหมวด";
    }
    return ids.length + " หมวด";
  }

  function dotFor(color) {
    const dot = document.createElement("span");
    dot.className = "dot " + (COLORS.includes(color) ? color : "slate");
    dot.setAttribute("aria-hidden", "true");
    return dot;
  }

  function toast(text) {
    toastEl.textContent = text;
    toastEl.hidden = false;
    requestAnimationFrame(() => toastEl.classList.add("on"));
    clearTimeout(toast.hideTimer);
    clearTimeout(toast.offTimer);
    toast.hideTimer = setTimeout(() => {
      toastEl.classList.remove("on");
      toast.offTimer = setTimeout(() => { toastEl.hidden = true; }, 220);
    }, 2600);
  }

  /* ----------------------------------------------------------- card copies */
  // A board that only exists in the /api/boards answer has no scene bounds here,
  // so its bento span falls back to the element count. Same thresholds as the
  // build (gallery/build.mjs sceneWeight), so both kinds of card agree.
  function weightFor(elements, width, height) {
    const count = Number(elements) || 0;
    const w = Math.max(0, Number(width) || 0);
    const h = Math.max(0, Number(height) || 0);
    const area = w * h;
    if (count >= 60 || area >= 1500000) return "large";
    if (count >= 25 || area >= 600000) return "wide";
    if (h > w * 1.6 && area >= 250000) return "tall";
    return "small";
  }

  function registerCard(card) {
    if (!card || !card.dataset.slug) return;
    card.hidden = false;
    prototypes.set(card.dataset.slug, card);
  }

  function cardCopy(slug, sectionKey) {
    const proto = prototypes.get(slug);
    if (!proto) return null;
    const card = proto.cloneNode(true);
    card.dataset.section = sectionKey;
    card.hidden = false;
    return card;
  }

  /* ------------------------------------------------------------ group menu */
  function showMenu(card, focusValue) {
    const pick = card.querySelector(".group-pick");
    const menu = pick && pick.querySelector(".group-menu");
    if (!menu || pick.hidden) return;
    menu.hidden = false;
    const trigger = pick.querySelector("button.card-group");
    if (trigger) trigger.setAttribute("aria-expanded", "true");
    openMenu = { slug: card.dataset.slug, section: card.dataset.section || "", focus: focusValue || null };
    if (focusValue) {
      const box = menu.querySelector('input[type="checkbox"][value="' + safeId(focusValue) + '"]');
      if (box) {
        try { box.focus({ preventScroll: true }); } catch (error) { box.focus(); }
      }
    }
  }

  function hideMenus(refocus) {
    const state = openMenu;
    for (const menu of boardsEl.querySelectorAll(".group-menu")) menu.hidden = true;
    for (const trigger of boardsEl.querySelectorAll("button.card-group")) {
      trigger.setAttribute("aria-expanded", "false");
    }
    openMenu = null;
    if (refocus && state) {
      const card = boardsEl.querySelector('.card[data-slug="' + safeId(state.slug) + '"]');
      const trigger = card && card.querySelector("button.card-group");
      if (trigger) trigger.focus();
    }
  }

  function openCardMenu(card, focusValue) {
    hideMenus(false);
    showMenu(card, focusValue);
  }

  function restoreOpenMenu() {
    if (!openMenu) return;
    const state = openMenu;
    openMenu = null;
    let card = null;
    if (state.section) {
      card = boardsEl.querySelector(
        '.board-section[data-group="' + safeId(state.section) + '"] .card[data-slug="' + safeId(state.slug) + '"]',
      );
    }
    if (!card) card = boardsEl.querySelector('.card[data-slug="' + safeId(state.slug) + '"]');
    if (!card) return;
    showMenu(card, state.focus);
  }

  /* Every copy gets its own trigger + menu; the label reads one name, N หมวด,
     or ไม่มีหมวด. Rebuilt whenever groups or membership change. */
  function syncMenus() {
    for (const pick of boardsEl.querySelectorAll(".group-pick")) {
      const card = pick.closest(".card");
      if (!card) continue;
      const slug = card.dataset.slug;
      const own = groupsOf(slug);
      pick.hidden = groups.length === 0;
      const trigger = pick.querySelector("button.card-group");
      if (trigger) {
        trigger.dataset.slug = slug;
        trigger.setAttribute("aria-label", "หมวดของ " + cardTitle(slug));
        trigger.setAttribute("aria-expanded", openMenu && openMenu.slug === slug ? "true" : "false");
        const lbl = trigger.querySelector(".lbl");
        if (lbl) lbl.textContent = menuLabel(own);
      }
      const menu = pick.querySelector(".group-menu");
      if (!menu) continue;
      const frag = document.createDocumentFragment();
      for (const group of groups) {
        const label = document.createElement("label");
        const box = document.createElement("input");
        box.type = "checkbox";
        box.value = group.id;
        box.checked = own.includes(group.id);
        box.setAttribute("aria-label", group.name);
        label.appendChild(box);
        label.appendChild(document.createTextNode(group.name));
        frag.appendChild(label);
      }
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "group-clear";
      clear.textContent = "ล้างหมวด";
      clear.setAttribute("aria-label", "ล้างหมวดของ " + cardTitle(slug));
      frag.appendChild(clear);
      menu.replaceChildren(frag);
      menu.hidden = !(openMenu && openMenu.slug === slug);
    }
  }

  /* One PATCH carries the whole new membership; a tick re-renders the sections
     but keeps the menu (and the checkbox just used) under the pointer. */
  function commitMembership(slug, nextIds, focusValue) {
    const card = boardsEl.querySelector('.card[data-slug="' + safeId(slug) + '"]');
    const section = card ? card.dataset.section || "" : "";
    const boxes = card ? [...card.querySelectorAll(".group-menu input[type=checkbox]")] : [];
    for (const box of boxes) box.disabled = true;
    const title = cardTitle(slug);
    apiJson("PATCH", "/api/boards/" + encodeURIComponent(slug) + "/meta", { groupIds: nextIds.slice() })
      .then(({ ok, status }) => {
        for (const box of boxes) box.disabled = false;
        if (!ok) throw new Error(String(status));
        if (nextIds.length) membership.set(slug, nextIds.slice());
        else membership.delete(slug);
        const names = nextIds.map((id) => (groupById(id) || {}).name).filter(Boolean);
        toast(
          nextIds.length
            ? "ตั้งหมวดของ “" + title + "” เป็น " + names.join(", ")
            : "ย้าย “" + title + "” ออกจากทุกหมวดแล้ว",
        );
        openMenu = { slug, section, focus: focusValue || null };
        layout();
        applyFilter();
      })
      .catch((error) => {
        for (const box of boxes) box.disabled = false;
        // revert to what the server actually holds
        const own = groupsOf(slug);
        for (const box of boxes) box.checked = own.includes(box.value);
        const status = Number(error && error.message) || 0;
        toast(
          status === 404
            ? "ไม่พบหมวดหรือกระดานนี้แล้ว — ยังไม่ได้บันทึก"
            : "บันทึกหมวดไม่สำเร็จ (เซิร์ฟเวอร์ไม่รับค่า)",
        );
      });
  }

  /* ---------------------------------------------------------------- layout */
  // Cards are laid out into one section per group plus a final "ไม่มีหมวดหมู่"
  // section. A board with N groups gets one cloned card per section; with no
  // groups it appears only under __none__. The master nodes stay detached.
  function layout() {
    const slugs = [...prototypes.keys()];
    /* no groups (backend without the API, or none created yet): keep the
       original flat grid and its id, so the page looks untouched */
    if (!groups.length) {
      const flat = document.createElement("div");
      flat.className = "grid";
      flat.id = "grid";
      for (const slug of slugs) {
        const card = cardCopy(slug, "");
        if (card) flat.appendChild(card);
      }
      let box = document.getElementById("sections");
      if (!box) {
        box = document.createElement("div");
        box.id = "sections";
      }
      boardsEl.replaceChildren(box);
      box.replaceChildren(flat);
      syncMenus();
      renderChips();
      restoreOpenMenu();
      return;
    }
    const keys = groups.map((group) => group.id).concat([NONE_KEY]);
    const buckets = new Map();
    for (const key of keys) buckets.set(key, []);
    for (const slug of slugs) {
      const own = groupsOf(slug);
      if (!own.length) buckets.get(NONE_KEY).push(slug);
      else for (const id of own) if (buckets.has(id)) buckets.get(id).push(slug);
    }
    const frag = document.createDocumentFragment();
    for (const key of keys) {
      const group = groupById(key);
      const section = document.createElement("section");
      section.className = "board-section";
      section.dataset.group = key;
      const label = group ? group.name : "ไม่มีหมวดหมู่";
      section.dataset.name = label;
      const head = document.createElement("div");
      head.className = "sect-head";
      head.appendChild(dotFor(group ? group.color : "slate"));
      const name = document.createElement("h2");
      name.className = "sect-name";
      name.textContent = label;
      head.appendChild(name);
      const total = document.createElement("span");
      total.className = "sect-count";
      total.textContent = String(buckets.get(key).length);
      head.appendChild(total);
      if (group) {
        const rename = document.createElement("button");
        rename.className = "sect-btn";
        rename.type = "button";
        rename.dataset.act = "group-rename";
        rename.dataset.group = group.id;
        rename.textContent = "แก้ชื่อ";
        rename.setAttribute("aria-label", "แก้ชื่อหมวด " + group.name);
        head.appendChild(rename);
        const del = document.createElement("button");
        del.className = "sect-btn danger";
        del.type = "button";
        del.dataset.act = "group-del";
        del.dataset.group = group.id;
        del.textContent = "ลบ";
        del.setAttribute("aria-label", "ลบหมวด " + group.name);
        head.appendChild(del);
      }
      const toggle = document.createElement("button");
      toggle.className = "sect-toggle";
      toggle.type = "button";
      toggle.dataset.act = "section-toggle";
      toggle.dataset.group = key;
      toggle.setAttribute("aria-expanded", "true");
      toggle.title = "หุบหมวดนี้";
      toggle.setAttribute("aria-label", "หุบหมวด " + label);
      toggle.innerHTML = ICONS.chevron;
      head.prepend(toggle);
      section.appendChild(head);
      const gridBox = document.createElement("div");
      gridBox.className = "grid";
      gridBox.id = "grid-" + key;
      toggle.setAttribute("aria-controls", gridBox.id);
      for (const slug of buckets.get(key)) {
        const card = cardCopy(slug, key);
        if (card) gridBox.appendChild(card);
      }
      section.appendChild(gridBox);
      applyCollapsed(section);
      frag.appendChild(section);
    }
    let box = document.getElementById("sections");
    if (!box) {
      box = document.createElement("div");
      box.id = "sections";
    }
    boardsEl.replaceChildren(box);
    box.replaceChildren(frag);
    syncMenus();
    renderChips();
    restoreOpenMenu();
  }

  function renderChips() {
    const frag = document.createDocumentFragment();
    const all = document.createElement("button");
    all.className = "chip";
    all.type = "button";
    all.dataset.group = "all";
    all.setAttribute("aria-pressed", activeGroup === "all" ? "true" : "false");
    all.textContent = "ทั้งหมด ";
    const total = document.createElement("span");
    total.className = "n";
    total.textContent = String(prototypes.size);
    all.appendChild(total);
    frag.appendChild(all);
    for (const group of groups) {
      const chip = document.createElement("button");
      chip.className = "chip";
      chip.type = "button";
      chip.dataset.group = group.id;
      chip.setAttribute("aria-pressed", activeGroup === group.id ? "true" : "false");
      chip.appendChild(dotFor(group.color));
      chip.appendChild(document.createTextNode(group.name + " "));
      const n = document.createElement("span");
      n.className = "n";
      n.textContent = String(countIn(group.id));
      chip.appendChild(n);
      frag.appendChild(chip);
    }
    groupChips.replaceChildren(frag);
  }

  /* ---------------------------------------------------------------- filter */
  function applyFilter() {
    const needle = q.value.trim().toLowerCase();
    // ค้นหาต้องกางให้เห็นของที่เจอ — ปล่อยว่างแล้วกลับไปหุบตามที่ตั้งไว้
    const sectionsBox = document.getElementById("sections");
    if (sectionsBox) sectionsBox.classList.toggle("searching", Boolean(needle));
    const shown = new Set();
    for (const card of cards()) {
      const slug = card.dataset.slug;
      const hit = !needle || (card.dataset.search || "").includes(needle);
      // a chip narrows to that group's own section: a board filed under two
      // groups otherwise shows up once per section, which reads as a duplicate
      const inChip = activeGroup === "all" || (card.dataset.section || "") === activeGroup;
      card.hidden = !hit || !inChip;
      if (!card.hidden) shown.add(slug);
    }
    for (const section of boardsEl.querySelectorAll(".board-section")) {
      // a board in two groups still counts once per section it is shown in
      const seen = new Set();
      let visible = 0;
      for (const card of section.querySelectorAll(".card")) {
        if (card.hidden || seen.has(card.dataset.slug)) continue;
        seen.add(card.dataset.slug);
        visible += 1;
      }
      section.hidden = visible === 0;
      const total = section.querySelector(".sect-count");
      if (total) total.textContent = String(visible);
    }
    const scoped = Boolean(needle) || activeGroup !== "all";
    count.textContent = scoped
      ? shown.size + " จาก " + prototypes.size
      : prototypes.size + " กระดาน";
    empty.textContent = needle
      ? "ไม่พบกระดานที่ตรงกับชื่อนี้"
      : "ไม่มีกระดานในหมวดนี้ — เลือก “ทั้งหมด” หรือย้ายกระดานเข้าหมวดนี้";
    empty.hidden = shown.size !== 0;
    // the folded bar mirrors the chip row: filter dot, or the group name itself
    syncBarChrome();
  }

  function fmtSize(bytes) {
    if (bytes > 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
    return Math.round(bytes / 1024) + " KB";
  }

  // One place updates every place a board name appears on a card copy, so a
  // rename in the editor, from this dialog, or from the API all converge.
  function paintCardTitle(card, id, title, subtitle) {
    if (!card) return;
    const name = title || id;
    const sub = subtitle || "";
    const h2 = card.querySelector("h2");
    if (h2) h2.textContent = name;
    card.dataset.search = (id + " " + name + " " + sub).toLowerCase();
    const shot = card.querySelector("a.shot");
    if (shot) shot.setAttribute("aria-label", "เปิด " + name);
    const rename = card.querySelector(".rename");
    if (rename) {
      rename.dataset.id = id;
      rename.setAttribute("aria-label", "แก้ชื่อ " + name);
      rename.title = "แก้ชื่อกระดาน";
    }
    const del = card.querySelector(".del");
    if (del) {
      del.dataset.id = id;
      del.setAttribute("aria-label", "ลบ " + name);
    }
    const pick = card.querySelector("button.card-group");
    if (pick) pick.setAttribute("aria-label", "หมวดของ " + name);
    const download = card.querySelector(".actions a[download]");
    if (download) download.setAttribute("aria-label", "ดาวน์โหลด " + name);
  }

  function updateCardTitle(slug, title, subtitle) {
    const proto = prototypes.get(slug);
    if (proto) paintCardTitle(proto, slug, title, subtitle);
    for (const card of cardsFor(slug)) paintCardTitle(card, slug, title, subtitle);
  }

  q.addEventListener("input", applyFilter);

  /* ----------------------------------------------------------------- theme */
  const themeBtn = document.getElementById("theme-toggle");
  const themeGlyph = themeBtn.querySelector(".theme-glyph");

  function currentTheme() {
    return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  }

  function paintThemeButton() {
    const dark = currentTheme() === "dark";
    themeGlyph.textContent = dark ? "☀" : "☾";
    themeBtn.setAttribute("aria-label", dark ? "สลับเป็นโหมดสว่าง" : "สลับเป็นโหมดมืด");
    themeBtn.title = dark ? "ใช้โหมดสว่าง" : "ใช้โหมดมืด";
  }

  function setTheme(theme, remember) {
    document.documentElement.setAttribute("data-theme", theme);
    if (remember) {
      try {
        localStorage.setItem("boards-theme", theme);
      } catch (err) {}
    }
    paintThemeButton();
  }

  themeBtn.addEventListener("click", () => {
    setTheme(currentTheme() === "dark" ? "light" : "dark", true);
  });
  paintThemeButton();
  const schemeQuery = matchMedia("(prefers-color-scheme: dark)");
  const onSchemeChange = (event) => {
    let stored = null;
    try {
      stored = localStorage.getItem("boards-theme");
    } catch (err) {}
    if (stored !== "dark" && stored !== "light") setTheme(event.matches ? "dark" : "light", false);
  };
  if (schemeQuery.addEventListener) schemeQuery.addEventListener("change", onSchemeChange);

  /* ------------------------------------------------------------ view modes */
  const VIEWS = ["card", "list", "bento"];
  const VIEW_KEY = "boards-view";
  const viewSwitch = document.getElementById("view-switch");
  const viewBtns = viewSwitch ? [...viewSwitch.querySelectorAll(".view-btn")] : [];

  function currentView() {
    return VIEWS.includes(document.body.dataset.view) ? document.body.dataset.view : "card";
  }

  // aria-checked follows the <body> attribute the pre-paint script already set,
  // so the switch is never briefly on the wrong item
  function paintViewSwitch() {
    const mode = currentView();
    for (const btn of viewBtns) {
      const on = btn.dataset.view === mode;
      btn.setAttribute("aria-checked", on ? "true" : "false");
      btn.tabIndex = on ? 0 : -1;
    }
  }

  function setView(mode, remember) {
    const next = VIEWS.includes(mode) ? mode : "card";
    document.body.dataset.view = next;
    if (remember) {
      try {
        localStorage.setItem(VIEW_KEY, next);
      } catch (err) {
        /* private mode: still switches for this page */
      }
    }
    paintViewSwitch();
  }

  if (viewSwitch) {
    viewSwitch.addEventListener("click", (event) => {
      const btn = event.target.closest(".view-btn");
      if (!btn || !VIEWS.includes(btn.dataset.view)) return;
      setView(btn.dataset.view, true);
    });
    // a radiogroup: the arrow keys move the choice and the focus together
    viewSwitch.addEventListener("keydown", (event) => {
      if (!event.target.closest(".view-btn")) return;
      const at = VIEWS.indexOf(currentView());
      let next = null;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") next = VIEWS[(at + 1) % VIEWS.length];
      else if (event.key === "ArrowLeft" || event.key === "ArrowUp")
        next = VIEWS[(at + VIEWS.length - 1) % VIEWS.length];
      else if (event.key === "Home") next = VIEWS[0];
      else if (event.key === "End") next = VIEWS[VIEWS.length - 1];
      if (!next) return;
      event.preventDefault();
      setView(next, true);
      const target = viewBtns.find((btn) => btn.dataset.view === next);
      if (target) target.focus();
    });
  }
  paintViewSwitch();

  /* -------------------------------------------------- collapsible group bar */
  const BAR_KEY = "boards-bar";
  const headerEl = document.querySelector("header");
  const barToggle = document.getElementById("bar-toggle");
  const barSummary = document.getElementById("bar-summary");
  // the pre-paint script parked the saved choice on <html>, which also lets CSS
  // hide the bar before this script runs; from here the flag is the source
  let barFoldedState = document.documentElement.getAttribute("data-bar") === "folded";
  // true once /api/groups has answered: only then is "no groups at all" a fact,
  // so the button is not hidden on a guess while the request is still open
  let groupsSettled = false;

  function syncBarChrome() {
    const folded = barFoldedState;
    document.documentElement.setAttribute("data-bar", folded ? "folded" : "open");
    if (headerEl) headerEl.dataset.bar = folded ? "folded" : "open";
    if (barToggle) {
      if (groupsSettled) barToggle.hidden = groups.length === 0;
      barToggle.setAttribute("aria-expanded", folded ? "false" : "true");
      barToggle.title = folded ? "ขยายหมวดหมู่" : "ย่อหมวดหมู่";
      barToggle.setAttribute("aria-label", barToggle.title);
      // a filter that is still on while its chips are hidden needs a hint dot
      if (folded && activeGroup !== "all") barToggle.dataset.filter = "1";
      else delete barToggle.dataset.filter;
    }
    const filtered = folded && activeGroup !== "all" ? groupById(activeGroup) : null;
    if (barSummary) {
      const label = barSummary.querySelector(".txt");
      if (label) label.textContent = filtered ? "กรอง: " + filtered.name : "";
      barSummary.hidden = !filtered;
    }
    groupbar.hidden = folded || groups.length === 0;
  }

  function setBar(folded, remember) {
    barFoldedState = folded;
    if (remember) {
      try {
        localStorage.setItem(BAR_KEY, folded ? "folded" : "open");
      } catch (err) {
        /* private mode: still folds for this page */
      }
    }
    syncBarChrome();
  }

  if (barToggle) barToggle.addEventListener("click", () => setBar(!barFoldedState, true));
  syncBarChrome();

  /* ---------------------------------------------------------------- groups */
  function apiJson(method, url, body) {
    const init = { method };
    if (body !== undefined) {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(body);
    }
    return fetch(url, init).then((res) =>
      res
        .json()
        .catch(() => ({}))
        .then((data) => ({ ok: res.ok, status: res.status, data })),
    );
  }

  function groupErrorText(status) {
    if (status === 409) return "มีชื่อหมวดนี้อยู่แล้ว";
    if (status === 400) return "ชื่อหมวดไม่ถูกต้อง — ต้องไม่ว่างและไม่ยาวเกิน 60 ตัวอักษร";
    if (status === 404) return "ไม่พบหมวดนี้แล้ว อาจถูกลบจากที่อื่น";
    return "บันทึกหมวดไม่สำเร็จ";
  }

  function normalizeGroup(raw) {
    if (!raw || typeof raw.id !== "string" || !raw.id) return null;
    return {
      id: raw.id,
      name: String(raw.name || "").trim() || raw.id,
      color: COLORS.includes(raw.color) ? raw.color : "slate",
      count: Number.isFinite(raw.count) ? raw.count : 0,
    };
  }

  function loadGroups() {
    return fetch("/api/groups")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data || !Array.isArray(data.groups)) {
          groups = [];
          groupsSettled = true;
          syncBarChrome();
          return false;
        }
        groups = data.groups.map(normalizeGroup).filter(Boolean);
        if (!groupById(activeGroup)) activeGroup = "all";
        groupsSettled = true;
        syncBarChrome();
        layout();
        applyFilter();
        return true;
      })
      .catch(() => {
        groups = [];
        groupsSettled = true;
        syncBarChrome();
        return false;
      });
  }

  // The catalogue is a static page, so membership comes from the API: prefer a
  // groupIds/groupId on /api/boards when the server sends one, otherwise ask
  // each board's meta endpoint.
  function idsForBoard(board) {
    if (board && Array.isArray(board.groupIds)) {
      return board.groupIds.filter((id) => typeof id === "string" && id);
    }
    if (board && typeof board.groupId === "string" && board.groupId) return [board.groupId];
    return [];
  }

  function loadMembership(boards) {
    const list = [...prototypes.keys()];
    const hasInline = boards.some(
      (board) =>
        board &&
        (Array.isArray(board.groupIds) ||
          Object.prototype.hasOwnProperty.call(board, "groupId")),
    );
    if (hasInline) {
      for (const board of boards) {
        if (!board || typeof board.id !== "string" || !prototypes.has(board.id)) continue;
        const ids = idsForBoard(board);
        if (ids.length) membership.set(board.id, ids);
        else membership.delete(board.id);
      }
      layout();
      applyFilter();
      return;
    }
    if (typeof fetch !== "function" || list.length === 0) return;
    const jobs = list.map((slug) =>
      fetch("/api/boards/" + encodeURIComponent(slug) + "/meta")
        .then((res) => (res.ok ? res.json() : null))
        .then((meta) => {
          if (!meta) return;
          const ids = idsForBoard(meta);
          if (ids.length) membership.set(slug, ids);
          else membership.delete(slug);
        })
        .catch(() => {}),
    );
    Promise.all(jobs).then(() => {
      layout();
      applyFilter();
    });
  }

  groupChips.addEventListener("click", (event) => {
    const chip = event.target.closest(".chip");
    if (!chip || !groupChips.contains(chip)) return;
    const next = chip.dataset.group;
    activeGroup = next === "all" || groupById(next) ? next : "all";
    for (const other of groupChips.querySelectorAll(".chip")) {
      other.setAttribute("aria-pressed", other.dataset.group === activeGroup ? "true" : "false");
    }
    applyFilter();
  });

  /* ------------------------------------------------------- group dialogs */
  const groupModal = document.getElementById("group-modal");
  const groupForm = document.getElementById("group-form");
  const groupName = document.getElementById("group-name");
  const groupNote = document.getElementById("group-note");
  const groupSave = document.getElementById("group-save");
  const groupTitle = document.getElementById("group-modal-title");
  const groupSub = document.getElementById("group-modal-sub");
  const groupColors = document.getElementById("group-colors");
  let groupEditId = null;
  let groupBusy = false;

  function pickedColor() {
    const picked = groupColors.querySelector('input[name="group-color"]:checked');
    return picked && COLORS.includes(picked.value) ? picked.value : "violet";
  }

  function setPickedColor(color) {
    const wanted = groupColors.querySelector('input[name="group-color"][value="' + safeId(color) + '"]');
    const first = groupColors.querySelector('input[name="group-color"]');
    if (wanted) wanted.checked = true;
    else if (first) first.checked = true;
  }

  function openGroupModal(group, trigger) {
    if (!groupModal.hidden) return;
    groupEditId = group ? group.id : null;
    groupBusy = false;
    groupTitle.textContent = group ? "แก้ชื่อหมวด" : "หมวดใหม่";
    groupSub.textContent = group
      ? "เปลี่ยนชื่อหรือสีของหมวดนี้ — กระดานข้างในไม่ถูกย้าย"
      : "ตั้งชื่อหมวดเพื่อจัดกลุ่มกระดานในหน้ารวมนี้";
    groupSave.textContent = group ? "บันทึกการแก้ไข" : "สร้างหมวด";
    groupNote.hidden = true;
    groupNote.textContent = "";
    groupName.value = group ? group.name : "";
    setPickedColor(group ? group.color : "violet");
    groupModal.hidden = false;
    groupModal._trigger = trigger || null;
    groupName.focus();
    groupName.select();
    requestAnimationFrame(() => {
      if (document.activeElement !== groupName) {
        groupName.focus();
        groupName.select();
      }
    });
  }

  function closeGroupModal() {
    if (groupBusy) return;
    const trigger = groupModal._trigger;
    groupModal.hidden = true;
    groupModal._trigger = null;
    groupEditId = null;
    if (trigger && trigger.isConnected) trigger.focus();
  }

  function showGroupNote(text) {
    groupNote.textContent = text;
    groupNote.hidden = false;
  }

  groupForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (groupBusy) return;
    const name = groupName.value.trim();
    if (!name) {
      showGroupNote("ชื่อหมวดต้องไม่ว่าง");
      groupName.focus();
      return;
    }
    const color = pickedColor();
    const editing = groupEditId;
    groupBusy = true;
    groupSave.disabled = true;
    groupSave.textContent = "กำลังบันทึก…";
    groupNote.hidden = true;
    const job = editing
      ? apiJson("PATCH", "/api/groups/" + encodeURIComponent(editing), { name, color })
      : apiJson("POST", "/api/groups", { name, color });
    job
      .then(({ ok, status, data }) => {
        if (!ok) throw new Error(groupErrorText(status));
        const group = normalizeGroup(data && data.group);
        if (!group) throw new Error("เซิร์ฟเวอร์ตอบกลับไม่ถูกต้อง");
        if (editing) {
          const old = groupById(editing);
          const keep = old ? old.name : editing;
          groups = groups.map((item) => (item.id === group.id ? group : item));
          toast("แก้ชื่อหมวดเป็น “" + group.name + "” แล้ว" + (keep === group.name ? "" : ""));
        } else {
          groups = groups.concat([group]);
          toast("สร้างหมวด “" + group.name + "” แล้ว");
        }
        groupBusy = false;
        groupSave.disabled = false;
        groupSave.textContent = editing ? "บันทึกการแก้ไข" : "สร้างหมวด";
        const trigger = groupModal._trigger;
        groupModal.hidden = true;
        groupModal._trigger = null;
        groupEditId = null;
        layout();
        applyFilter();
        if (trigger && trigger.isConnected) trigger.focus();
      })
      .catch((err) => {
        groupBusy = false;
        groupSave.disabled = false;
        groupSave.textContent = editing ? "บันทึกการแก้ไข" : "สร้างหมวด";
        showGroupNote(err && err.message ? err.message : "บันทึกหมวดไม่สำเร็จ");
        groupName.focus();
      });
  });

  document.getElementById("group-cancel").addEventListener("click", closeGroupModal);
  groupModal.addEventListener("pointerdown", (event) => {
    if (event.target === groupModal) closeGroupModal();
  });

  /* ------------------------------------------------------ delete a group */
  const gdelModal = document.getElementById("group-del-modal");
  const gdelDetail = document.getElementById("group-del-detail");
  const gdelConfirm = document.getElementById("group-del-confirm");
  let gdelGroup = null;
  let gdelBusy = false;

  function openGroupDelete(group, trigger) {
    if (!gdelModal.hidden) return;
    gdelGroup = group;
    gdelBusy = false;
    const n = countIn(group.id);
    gdelDetail.textContent =
      "ลบหมวด “" + group.name + "” — กระดาน " + n + " ใบจะออกจากหมวดนี้ " +
      "(ใบที่ไม่มีหมวดอื่นจะไปอยู่ที่ “ไม่มีหมวดหมู่”) และไม่ถูกลบ";
    gdelConfirm.disabled = false;
    gdelConfirm.textContent = "ลบหมวด";
    gdelModal.hidden = false;
    gdelModal._trigger = trigger || null;
    gdelConfirm.focus();
  }

  function closeGroupDelete() {
    if (gdelBusy) return;
    const trigger = gdelModal._trigger;
    gdelModal.hidden = true;
    gdelModal._trigger = null;
    gdelGroup = null;
    if (trigger && trigger.isConnected) trigger.focus();
  }

  gdelConfirm.addEventListener("click", () => {
    if (gdelBusy || !gdelGroup) return;
    const group = gdelGroup;
    const local = countIn(group.id);
    gdelBusy = true;
    gdelConfirm.disabled = true;
    gdelConfirm.textContent = "กำลังลบ…";
    apiJson("DELETE", "/api/groups/" + encodeURIComponent(group.id))
      .then(({ ok, status, data }) => {
        if (!ok) throw new Error(groupErrorText(status));
        const moved = data && Number.isFinite(data.moved) ? data.moved : local;
        groups = groups.filter((item) => item.id !== group.id);
        let toNone = 0;
        for (const [slug, ids] of [...membership.entries()]) {
          const next = (Array.isArray(ids) ? ids : []).filter((id) => id !== group.id);
          if (next.length) membership.set(slug, next);
          else {
            membership.delete(slug);
            toNone += 1;
          }
        }
        if (activeGroup === group.id) activeGroup = "all";
        gdelBusy = false;
        gdelConfirm.disabled = false;
        gdelConfirm.textContent = "ลบหมวด";
        const trigger = gdelModal._trigger;
        gdelModal.hidden = true;
        gdelModal._trigger = null;
        gdelGroup = null;
        layout();
        applyFilter();
        const bits = [];
        if (toNone) bits.push("ย้าย " + toNone + " ใบไปไม่มีหมวดหมู่");
        const stayed = moved - toNone;
        if (stayed > 0) bits.push(stayed + " ใบยังอยู่ในหมวดอื่น");
        toast("ลบหมวด “" + group.name + "” แล้ว · " + (bits.join(" · ") || "ไม่มีกระดานถูกย้าย"));
        if (trigger && trigger.isConnected) trigger.focus();
      })
      .catch((err) => {
        gdelBusy = false;
        gdelConfirm.disabled = false;
        gdelConfirm.textContent = "ลบหมวด";
        toast(err && err.message ? err.message : "ลบหมวดไม่สำเร็จ");
      });
  });

  document.getElementById("group-del-cancel").addEventListener("click", closeGroupDelete);
  gdelModal.addEventListener("pointerdown", (event) => {
    if (event.target === gdelModal) closeGroupDelete();
  });

  /* ----------------------------------------------------- rename a board */
  const renameModal = document.getElementById("rename-modal");
  const renameForm = document.getElementById("rename-form");
  const renameInput = document.getElementById("rename-input");
  const renameNote = document.getElementById("rename-note");
  const renameSave = document.getElementById("rename-save");
  let renameId = null;
  let renameBusy = false;

  function openRename(id, title, trigger) {
    if (!renameModal.hidden) return;
    if (!modal.hidden && !deleting) closeDelete();
    renameId = id;
    renameBusy = false;
    renameNote.hidden = true;
    renameNote.textContent = "";
    renameInput.value = title || id;
    renameModal.hidden = false;
    renameModal._trigger = trigger || null;
    renameInput.focus();
    renameInput.select();
    // Some browsers need a frame before the input is focusable after [hidden] is removed.
    requestAnimationFrame(() => {
      if (document.activeElement !== renameInput) {
        renameInput.focus();
        renameInput.select();
      }
    });
  }

  function closeRename() {
    if (renameBusy) return;
    const trigger = renameModal._trigger;
    renameModal.hidden = true;
    renameModal._trigger = null;
    renameId = null;
    if (trigger && trigger.isConnected) trigger.focus();
  }

  function showRenameNote(text) {
    renameNote.textContent = text;
    renameNote.hidden = false;
  }

  renameForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (renameBusy || !renameId) return;
    const id = renameId;
    const next = renameInput.value.trim();
    if (!next) {
      showRenameNote("ชื่อต้องไม่ว่าง");
      renameInput.focus();
      return;
    }
    renameBusy = true;
    renameSave.disabled = true;
    renameSave.textContent = "กำลังบันทึก…";
    renameNote.hidden = true;
    fetch("/api/boards/" + encodeURIComponent(id) + "/meta", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: next }),
    })
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.json();
      })
      .then((meta) => {
        updateCardTitle(id, (meta && meta.title) || next, meta && meta.subtitle);
        const trigger = renameModal._trigger;
        renameBusy = false;
        renameSave.disabled = false;
        renameSave.textContent = "บันทึกชื่อ";
        renameModal.hidden = true;
        renameModal._trigger = null;
        renameId = null;
        if (trigger && trigger.isConnected) trigger.focus();
        applyFilter();
      })
      .catch((err) => {
        renameBusy = false;
        renameSave.disabled = false;
        renameSave.textContent = "บันทึกชื่อ";
        showRenameNote("บันทึกชื่อไม่สำเร็จ" + (err && err.message ? " (" + err.message + ")" : ""));
        renameInput.focus();
      });
  });

  document.getElementById("rename-cancel").addEventListener("click", closeRename);
  renameModal.addEventListener("pointerdown", (event) => {
    if (event.target === renameModal) closeRename();
  });

  /* ---------------------------------------------------- delete a board */
  // delete a board from the catalogue: custom dialog + hold-to-confirm button
  const modal = document.getElementById("del-modal");
  const detail = document.getElementById("del-detail");
  const holdBtn = document.getElementById("del-hold");
  const holdFill = holdBtn.querySelector(".fill");
  const holdLbl = holdBtn.querySelector(".lbl");
  const HOLD_MS = 1100;
  let pendingId = null;
  let holdRaf = 0;
  let holdStart = 0;
  let deleting = false;

  function openDelete(id) {
    if (!groupModal.hidden && !groupBusy) closeGroupModal();
    if (!gdelModal.hidden && !gdelBusy) closeGroupDelete();
    if (!renameModal.hidden && !renameBusy) closeRename();
    pendingId = id;
    deleting = false;
    detail.textContent = id + ".excalidraw จะถูกลบถาวรพร้อมประวัติเซฟย้อนหลัง กู้คืนไม่ได้";
    holdFill.style.width = "0%";
    holdLbl.textContent = "กดค้างเพื่อลบ";
    holdBtn.disabled = false;
    modal.hidden = false;
    holdBtn.focus();
  }

  function closeDelete() {
    if (deleting) return;
    cancelAnimationFrame(holdRaf);
    holdRaf = 0;
    holdFill.style.width = "0%";
    modal.hidden = true;
    pendingId = null;
  }

  function stopHold() {
    if (deleting) return;
    cancelAnimationFrame(holdRaf);
    holdRaf = 0;
    holdFill.style.width = "0%";
  }

  function finishHold() {
    cancelAnimationFrame(holdRaf);
    holdRaf = 0;
    deleting = true;
    holdBtn.disabled = true;
    holdLbl.textContent = "กำลังลบ...";
    holdFill.style.width = "100%";
    const id = pendingId;
    fetch("/api/boards/" + encodeURIComponent(id), { method: "DELETE" })
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        for (const card of cardsFor(id)) card.remove();
        prototypes.delete(id);
        membership.delete(id);
        deleting = false;
        modal.hidden = true;
        pendingId = null;
        layout();
        applyFilter();
      })
      .catch(() => {
        deleting = false;
        holdBtn.disabled = false;
        holdLbl.textContent = "ลบไม่สำเร็จ พอกดค้างอีกครั้ง";
        holdFill.style.width = "0%";
      });
  }

  function tickHold() {
    const ratio = Math.min(1, (performance.now() - holdStart) / HOLD_MS);
    holdFill.style.width = ratio * 100 + "%";
    if (ratio >= 1) {
      finishHold();
      return;
    }
    holdRaf = requestAnimationFrame(tickHold);
  }

  function startHold(event) {
    if (deleting || !pendingId) return;
    event.preventDefault();
    holdStart = performance.now();
    if (holdBtn.setPointerCapture && event.pointerId !== undefined) {
      try { holdBtn.setPointerCapture(event.pointerId); } catch (err) {}
    }
    cancelAnimationFrame(holdRaf);
    holdRaf = requestAnimationFrame(tickHold);
  }

  // one delegated handler for the whole catalogue: cards are cloned between
  // sections, so the listener lives on the wrapper that never gets replaced
  boardsEl.addEventListener("click", (event) => {
    const target = event.target;
    const openTrigger = target.closest && target.closest("button.card-group");
    if (openTrigger) {
      const card = openTrigger.closest(".card");
      if (!card) return;
      const menu = card.querySelector(".group-menu");
      if (menu && !menu.hidden) hideMenus(false);
      else openCardMenu(card, null);
      return;
    }
    const clear = target.closest && target.closest(".group-clear");
    if (clear) {
      const card = clear.closest(".card");
      if (card) commitMembership(card.dataset.slug, [], null);
      return;
    }
    const sect = target.closest && target.closest("[data-act]");
    if (sect && sect.dataset.act === "section-toggle") {
      event.preventDefault();
      const section = sect.closest(".board-section");
      if (section) toggleSection(section);
      return;
    }
    if (sect && sect.dataset.act) {
      const group = groupById(sect.dataset.group);
      if (!group) return;
      event.preventDefault();
      if (sect.dataset.act === "group-rename") openGroupModal(group, sect);
      else if (sect.dataset.act === "group-del") openGroupDelete(group, sect);
      return;
    }
    const rename = target.closest && target.closest(".rename");
    if (rename && !rename.disabled) {
      event.preventDefault();
      const card = rename.closest(".card");
      const h2 = card && card.querySelector("h2");
      if (rename.dataset.id) openRename(rename.dataset.id, h2 ? h2.textContent : "", rename);
      return;
    }
    const btn = target.closest && target.closest(".del");
    if (!btn || btn.disabled) return;
    event.preventDefault();
    const id = btn.dataset.id;
    if (id) openDelete(id);
  });

  // ticking/unticking any group sends the whole membership in one PATCH
  boardsEl.addEventListener("change", (event) => {
    const box = event.target;
    if (!box || box.type !== "checkbox" || !box.closest(".group-menu")) return;
    const card = box.closest(".card");
    if (!card) return;
    const ids = [];
    for (const input of card.querySelectorAll(".group-menu input[type=checkbox]")) {
      if (input.checked) ids.push(input.value);
    }
    commitMembership(card.dataset.slug, ids, box.value);
  });

  // an outside click closes the menu; a click inside it (another tick) does not
  document.addEventListener("pointerdown", (event) => {
    if (!openMenu) return;
    if (event.target.closest && event.target.closest(".group-pick")) return;
    hideMenus(false);
  });

  groupNew.addEventListener("click", () => openGroupModal(null, groupNew));

  document.getElementById("del-cancel").addEventListener("click", closeDelete);
  modal.addEventListener("pointerdown", (event) => {
    if (event.target === modal) closeDelete();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (openMenu) hideMenus(true);
    else if (!groupModal.hidden) closeGroupModal();
    else if (!gdelModal.hidden) closeGroupDelete();
    else if (!renameModal.hidden) closeRename();
    else if (!modal.hidden) closeDelete();
  });
  holdBtn.addEventListener("pointerdown", startHold);
  holdBtn.addEventListener("pointerup", stopHold);
  holdBtn.addEventListener("pointercancel", stopHold);
  holdBtn.addEventListener("keydown", (event) => {
    if ((event.key === " " || event.key === "Enter") && !event.repeat) startHold(event);
  });
  holdBtn.addEventListener("keyup", (event) => {
    if (event.key === " " || event.key === "Enter") stopHold();
  });

  // Boards saved through the editor may not have a rendered preview yet: list
  // them straight from the API so nothing on the server is invisible.
  fetch("/api/boards")
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (!data || !Array.isArray(data.boards)) return;
      const boards = data.boards;
      const alive = new Set(boards.map((board) => board.id));
      // The page is a snapshot: a board deleted after the last build must not
      // stay clickable here until someone rebuilds the catalog.
      let removed = 0;
      for (const slug of [...prototypes.keys()]) {
        if (alive.has(slug)) continue;
        prototypes.delete(slug);
        membership.delete(slug);
        removed += 1;
      }
      // Renames in the editor only write the sidecar, so the static card keeps
      // the name it was built with. Refresh it here instead of keeping two
      // names for the same board until someone rebuilds the catalogue.
      const byId = new Map(boards.map((board) => [board.id, board]));
      for (const slug of [...prototypes.keys()]) {
        const board = byId.get(slug);
        if (!board) continue;
        updateCardTitle(slug, board.title || board.id, board.subtitle || "");
      }
      const known = new Set(prototypes.keys());
      let added = 0;
      for (const board of boards) {
        if (known.has(board.id)) continue;
        const href = "/b/" + encodeURIComponent(board.id);
        const card = document.createElement("article");
        card.className = "card";
        card.dataset.slug = board.id;
        card.dataset.weight = weightFor(board.elements);
        card.dataset.group = "";
        card.dataset.groups = "";
        card.dataset.search = (board.id + " " + (board.title || "")).toLowerCase();
        card.innerHTML =
          '<a class="shot" href="' + href + '"><span class="placeholder">บันทึกบนเซิร์ฟเวอร์</span></a>' +
          '<div class="body"><h2></h2><p class="meta"></p>' +
          '<div class="group-pick" hidden><button type="button" class="card-group" aria-haspopup="true" aria-expanded="false">' +
          '<span class="lbl">ไม่มีหมวด</span><span class="chev">' + ICONS.chevron + '</span></button>' +
          '<div class="group-menu" hidden></div></div>' +
          '<div class="actions">' +
          '<a class="primary" href="' + href + '">เปิด</a><span class="grow"></span>' +
          '<button class="iconbtn rename" type="button" aria-label="แก้ชื่อกระดาน" title="แก้ชื่อกระดาน">' +
          ICONS.pencil + '<span>แก้ชื่อ</span></button>' +
          '<a class="iconbtn" download aria-label="ดาวน์โหลด" title="ดาวน์โหลด">' + ICONS.download + '</a>' +
          '<button class="iconbtn danger del" type="button" aria-label="ลบกระดาน" title="ลบ">' +
          ICONS.trash + '<span>ลบ</span></button></div></div>';
        card.querySelector(".rename").dataset.id = board.id;
        card.querySelector(".del").dataset.id = board.id;
        card.querySelector(".meta").textContent =
          (board.elements ?? "?") + " elements · " + fmtSize(board.bytes) + " · " +
          new Date(board.updated).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
        card.querySelector(".meta").title = new Date(board.updated).toLocaleDateString("en-GB", {
          day: "numeric", month: "short", year: "numeric",
        });
        card.querySelector("a.iconbtn").href = "/scenes/" + encodeURIComponent(board.id) + ".excalidraw";
        paintCardTitle(card, board.id, board.title || board.id, board.subtitle || "");
        registerCard(card);
        added += 1;
      }
      if (added || removed) {
        layout();
        applyFilter();
      }
      loadMembership(boards);
    })
    .catch(() => {});

  // start from the group hints the builder wrote, then let the API correct them
  for (const card of cards()) {
    registerCard(card);
    const hints = (card.dataset.groups || "").split(/\s+/).filter(Boolean);
    if (hints.length) membership.set(card.dataset.slug, hints);
    else if (card.dataset.group) membership.set(card.dataset.slug, [card.dataset.group]);
  }
  layout();
  applyFilter();
  loadGroups();

</script>
</body>
</html>
`;
}

/* -------------------------------------------------------------------- main */

async function main() {
  mkdirSync(THUMBS, { recursive: true });
  mkdirSync(OUT_SCENES, { recursive: true });
  for (const name of LOGO_FILES) {
    const from = join(LOGO_DIR, name);
    if (existsSync(from)) copyFileSync(from, join(SITE, name));
  }

  const scenes = collectScenes();
  if (scenes.length === 0) {
    // a brand-new install has no boards yet: write the empty catalogue instead
    // of failing, so / is a page with a "+ กระดานใหม่" button and not a 404
    process.stderr.write(`no boards in ${SCENES} yet (expected <id>/scene.excalidraw)\n`);
  }

  // Drop thumbnails/copies whose source scene no longer exists. Only the files
  // this build owns are swept: `.thumb-*.png` in SITE belong to a render that
  // may still be running (the watcher plus a container rebuild can overlap).
  const keepPng = new Set(scenes.map((s) => `${s.slug}.png`));
  for (const file of readdirSync(THUMBS)) {
    if (!file.endsWith(".png") || keepPng.has(file)) continue;
    rmSync(join(THUMBS, file), { force: true });
  }
  const keepScene = new Set(scenes.map((s) => `${s.slug}.excalidraw`));
  for (const file of readdirSync(OUT_SCENES)) {
    if (!file.endsWith(".excalidraw") || keepScene.has(file)) continue;
    rmSync(join(OUT_SCENES, file), { force: true });
  }
  // A render that died before its rename leaves one of these behind; they are
  // invisible to the page but should not pile up in the site root.
  for (const file of readdirSync(SITE)) {
    if (!file.startsWith(".thumb-")) continue;
    const path = join(SITE, file);
    if (Date.now() - statSync(path).mtimeMs > 10 * 60_000) rmSync(path, { force: true });
  }

  process.stdout.write(`building ${scenes.length} board(s) from ${SCENES}\n`);

  const rendered = await mapWithLimit(scenes, CONCURRENCY, async (scene) => {
    const info = describeScene(scene);
    const thumbPath = join(THUMBS, `${scene.slug}.png`);
    const result = await renderThumbnail(scene, thumbPath);
    if (!result.ok && result.skipped) {
      process.stdout.write(`  · ${scene.slug} (no preview yet)\n`);
    } else if (!result.ok) {
      process.stdout.write(`  ! ${scene.slug}: thumbnail failed — ${result.error || "unknown"}\n`);
    } else {
      process.stdout.write(`  ${result.cached ? "=" : "✓"} ${scene.slug}\n`);
    }
    copyFileSync(scene.path, join(OUT_SCENES, `${scene.slug}.excalidraw`));
    return { scene, info, thumb: result.ok && existsSync(thumbPath) };
  });

  const entries = rendered
    .map(({ scene, info, thumb }) => {
      const file = join(THUMBS, `${scene.slug}.png`);
      const px = thumb ? pngSize(file) : null;
      return {
        id: scene.id,
        slug: scene.slug,
        title: scene.meta.title || humanize(scene.slug),
        subtitle: scene.meta.subtitle || "",
        tags: scene.meta.tags || [],
        // meta.json may remember the catalogue group(s); the API is
        // authoritative, this only avoids a flash of "ไม่มีหมวดหมู่" on first paint
        groupId: Array.isArray(scene.meta.groupIds)
          ? typeof scene.meta.groupIds[0] === "string"
            ? scene.meta.groupIds[0]
            : ""
          : typeof scene.meta.groupId === "string"
            ? scene.meta.groupId
            : "",
        groupIds: Array.isArray(scene.meta.groupIds)
          ? scene.meta.groupIds.filter((id) => typeof id === "string" && id)
          : typeof scene.meta.groupId === "string" && scene.meta.groupId
            ? [scene.meta.groupId]
            : [],
        elements: info.elements,
        frames: info.frames,
        width: px?.width || info.width,
        height: px?.height || info.height,
        // the bento span follows the scene itself, not the thumbnail bitmap:
        // every thumb is the same size, so it would weigh them all alike
        weight: sceneWeight(info.elements, info.width, info.height),
        size: info.size,
        sizeLabel: formatBytes(info.size),
        updated: info.updated,
        thumb,
        mtime: Math.round(statSync(scene.path).mtimeMs),
      };
    })
    // newest first, then a stable tiebreak so a rebuild never reshuffles cards
    // that were saved in the same minute
    .sort((a, b) => b.updated - a.updated || a.title.localeCompare(b.title, "th"));

  const generatedAt = new Date().toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  writeAtomic(join(SITE, "index.html"), renderPage(entries, generatedAt));
  writeAtomic(
    join(SITE, "manifest.json"),
    `${JSON.stringify({ generatedAt, boards: entries.map(({ mtime, ...rest }) => rest) }, null, 2)}\n`,
  );

  const failed = entries.filter((e) => !e.thumb).length;
  process.stdout.write(
    `\n${entries.length} board(s) → ${join(SITE, "index.html")}` +
      `${failed ? ` (${failed} without preview)` : ""}\n`,
  );
}

try {
  await main();
} catch (error) {
  process.stderr.write(`error: ${error.message}\n`);
  process.exit(1);
}
