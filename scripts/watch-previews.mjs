#!/usr/bin/env node
/**
 * scripts/watch-previews.mjs — keep the catalogue's PNG previews in step with
 * the boards while you work.
 *
 * Why this exists: previews can only be rendered on the host, because the
 * `excalidraw` CLI drives a real browser and the runtime image carries neither.
 * The container rewrites index.html after every save but runs
 * `build.mjs --no-render`, so a board that changed keeps the picture it had at
 * the last manual build. This watcher closes that gap: it watches the board
 * folders, lets the editor's saves settle, then runs `gallery/build.mjs`, which
 * renders only the thumbnails that are missing or older than their scene.
 *
 * Usage
 *   node scripts/watch-previews.mjs                # build once, then watch
 *   node scripts/watch-previews.mjs --no-initial   # watch only
 *   node scripts/watch-previews.mjs --once         # one build, no watch
 *   QUIET_MS=1500 MIN_GAP_MS=4000 node scripts/watch-previews.mjs
 *
 * Stop with Ctrl-C. One watcher per checkout: a pid file under .cache/ stops a
 * second copy from rendering the same boards at the same time.
 *
 * Environment
 *   SCENES_DIR       boards   (default <repo>/gallery/scenes)
 *   SITE_DIR         catalog  (default <repo>/gallery/site)
 *   PREVIEW_BUILD    build script (default <repo>/gallery/build.mjs)
 *   PREVIEW_LOCK     pid file (default <repo>/.cache/preview-watcher.pid)
 *   QUIET_MS         wait this long after the last save (default 2000)
 *   MIN_GAP_MS       never start two builds closer than this (default 4000)
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const SCENES = resolve(process.env.SCENES_DIR || join(ROOT, "gallery", "scenes"));
const SITE = resolve(process.env.SITE_DIR || join(ROOT, "gallery", "site"));
const BUILD = resolve(process.env.PREVIEW_BUILD || join(ROOT, "gallery", "build.mjs"));
const QUIET_MS = Number(process.env.QUIET_MS || 2000);
const MIN_GAP_MS = Number(process.env.MIN_GAP_MS || 4000);
const LOCK = resolve(process.env.PREVIEW_LOCK || join(ROOT, ".cache", "preview-watcher.pid"));
const INITIAL = !process.argv.includes("--no-initial");
const ONCE = process.argv.includes("--once");

const log = (...args) =>
  console.log(`[${new Date().toLocaleTimeString("en-GB", { hour12: false })}]`, ...args);

/* --------------------------------------------------------------- one owner */

function livePid() {
  let pid = 0;
  try {
    pid = Number(readFileSync(LOCK, "utf8").trim());
  } catch {
    return 0;
  }
  if (!Number.isInteger(pid) || pid <= 0) return 0;
  try {
    process.kill(pid, 0); // signal 0 only asks "does this process exist?"
    return pid;
  } catch {
    return 0; // ESRCH: the previous watcher is gone, its pid file is debris
  }
}

function takeLock() {
  const owner = livePid();
  if (owner && owner !== process.pid) {
    log(`another watcher is already running (pid ${owner}); nothing to do`);
    process.exit(0);
  }
  mkdirSync(dirname(LOCK), { recursive: true });
  writeFileSync(LOCK, String(process.pid));
}

function releaseLock() {
  try {
    if (Number(readFileSync(LOCK, "utf8").trim()) === process.pid) rmSync(LOCK, { force: true });
  } catch {
    /* already gone */
  }
}

/* ----------------------------------------------------------- change filter */

/* A save touches three kinds of file: the scene (what a preview shows), the
   meta sidecar (title/group — the server's own rebuild handles those), and a
   history snapshot. Only the scene matters here. */
function isSceneChange(relative) {
  if (!relative) return true; // some platforms omit the name; rebuild to be safe
  const rel = relative.split("\\").join("/");
  const file = rel.slice(rel.lastIndexOf("/") + 1);
  if (file.startsWith(".")) return false; // .groups.json, .tmp-…, .DS_Store
  if (rel.includes("/history/") || rel.startsWith("history/")) return false;
  if (file === "meta.json") return false;
  return file === "scene.excalidraw" || file.endsWith(".excalidraw");
}

/* ---------------------------------------------------------------- building */

let timer = null;
let running = false;
let pending = false;
let lastStart = 0;
let child = null;

function schedule(delay = QUIET_MS) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(fire, delay);
}

function fire() {
  timer = null;
  if (running) {
    pending = true;
    return;
  }
  const wait = lastStart + MIN_GAP_MS - Date.now();
  if (wait > 0) {
    // a save landed just after the last render started: let it settle
    schedule(wait);
    return;
  }
  void runBuild();
}

function runBuild() {
  running = true;
  pending = false;
  lastStart = Date.now();
  log("rendering previews…");
  child = spawn(process.execPath, [BUILD], {
    cwd: ROOT,
    env: { ...process.env, SCENES_DIR: SCENES, SITE_DIR: SITE },
    stdio: "inherit",
  });
  return new Promise((resolveBuild) => {
    let done = false;
    const finish = (code, error) => {
      if (done) return;
      done = true;
      running = false;
      child = null;
      if (error) log("build failed —", error.message);
      else if (code !== 0) log("build exited with", code);
      else log("previews up to date");
      if (pending) schedule(0);
      resolveBuild();
    };
    child.on("error", (error) => finish(null, error));
    child.on("exit", (code) => finish(code));
  });
}

/* -------------------------------------------------------------------- main */

function shutdown(code = 0) {
  if (timer) clearTimeout(timer);
  if (child) child.kill("SIGTERM");
  releaseLock();
  process.exit(code);
}

takeLock();
process.on("exit", releaseLock);
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

if (INITIAL || ONCE) await runBuild();
if (ONCE) shutdown(0);

try {
  watch(SCENES, { recursive: true }, (event, filename) => {
    if (event !== "change" && event !== "rename") return;
    if (!isSceneChange(filename)) return;
    schedule();
  });
} catch (error) {
  log(`cannot watch ${SCENES}: ${error.message}`);
  shutdown(1);
}
log(`watching ${SCENES} (quiet ${QUIET_MS} ms, min gap ${MIN_GAP_MS} ms)`);
