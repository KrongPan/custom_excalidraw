#!/usr/bin/env node
/**
 * scripts/test-preview-watcher.mjs — prove previews follow the boards.
 *
 * The catalogue's PNGs are rendered on the host only (scripts/watch-previews.mjs
 * + gallery/build.mjs). This test runs the real watcher against a throwaway
 * board folder and checks, with no browser assertions needed:
 *
 *   - the first pass renders a thumbnail and writes the catalogue;
 *   - editing scene.excalidraw triggers a fresh render (different PNG bytes),
 *     so a board that changed never keeps its old picture;
 *   - the thumbnail is stamped with the scene it came from, so a board saved
 *     while its preview renders is picked up again instead of counted as fresh;
 *   - history snapshots and meta.json do not trigger renders.
 *
 * Usage: node scripts/test-preview-watcher.mjs
 * Needs: node 22+, the `excalidraw` CLI on PATH. Exits non-zero on failure.
 * Uses only temp folders (SCENES_DIR/SITE_DIR), never the real gallery.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const WATCH = path.join(ROOT, "scripts", "watch-previews.mjs");
const BUILD = path.join(ROOT, "gallery", "build.mjs");

const results = [];
let watcher = null;
let tmp = null;

function check(name, ok, detail = "") {
  const pass = Boolean(ok);
  results.push({ name, ok: pass, detail: String(detail || "") });
  process.stdout.write(`  ${pass ? "✓" : "✗"} ${name}${detail && !pass ? ` — ${detail}` : ""}\n`);
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

function scene(elements) {
  return {
    type: "excalidraw",
    version: 2,
    source: "preview-watcher-test",
    elements,
    appState: { viewBackgroundColor: "#ffffff", gridSize: null },
    files: {},
  };
}

function rect(id, x, width, updated) {
  return {
    id,
    type: "rectangle",
    x,
    y: 0,
    width,
    height: 120,
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
    versionNonce: 1,
    isDeleted: false,
    updated,
    boundElements: null,
    link: null,
    locked: false,
  };
}

async function digest(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  tmp = await mkdtemp(path.join(os.tmpdir(), "preview-watcher-"));
  const scenes = path.join(tmp, "scenes");
  const site = path.join(tmp, "site");
  const board = "board-209901010000";
  const sceneFile = path.join(scenes, board, "scene.excalidraw");
  const thumbFile = path.join(site, "thumbs", `${board}.png`);
  const moved = path.join(scenes, board, "history", "2099-01-01T00-00-00-000Z.excalidraw");

  await mkdir(path.dirname(sceneFile), { recursive: true });
  await mkdir(path.dirname(moved), { recursive: true });
  await writeFile(sceneFile, JSON.stringify(scene([rect("a", 0, 200, Date.now())])));

  watcher = spawn(process.execPath, [WATCH], {
    cwd: ROOT,
    env: {
      ...process.env,
      SCENES_DIR: scenes,
      SITE_DIR: site,
      PREVIEW_BUILD: BUILD,
      PREVIEW_LOCK: path.join(tmp, "watcher.pid"),
      QUIET_MS: "300",
      MIN_GAP_MS: "500",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  watcher.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  watcher.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });

  await waitFor(
    async () => existsSync(thumbFile) && existsSync(path.join(site, "index.html")),
    30000,
    "the first build to render a preview",
  );
  const firstBytes = await digest(thumbFile);
  const firstManifest = JSON.parse(await readFile(path.join(site, "manifest.json"), "utf8"));
  check("initial pass renders a preview and a catalogue", firstBytes.length === 64 && firstManifest.boards.length === 1);

  const html = await readFile(path.join(site, "index.html"), "utf8");
  check("the catalogue points at the rendered thumbnail", html.includes(`/gallery/thumbs/${board}.png`));

  // A real edit, written the way the server writes it: temp file then rename,
  // so the watcher is tested against the rename the API actually performs.
  const edit = JSON.stringify(scene([rect("a", 0, 200, Date.now()), rect("b", 260, 160, Date.now())]));
  await writeFile(`${sceneFile}.tmp-1-test`, edit);
  await rename(`${sceneFile}.tmp-1-test`, sceneFile);
  await waitFor(async () => (await digest(thumbFile)) !== firstBytes, 30000, "the edited board to be re-rendered");
  const secondBytes = await digest(thumbFile);
  check("editing the scene re-renders the preview", secondBytes !== firstBytes);

  const sceneStat = await stat(sceneFile);
  const thumbStat = await stat(thumbFile);
  // `Math.floor` because the render is stamped with ceil(scene mtime), which
  // lands in the same millisecond as the scene or one above it
  check(
    "the preview is stamped with the scene it came from",
    Math.abs(thumbStat.mtimeMs - Math.ceil(sceneStat.mtimeMs)) < 2,
    `thumb ${thumbStat.mtimeMs} vs scene ${sceneStat.mtimeMs}`,
  );

  // meta.json is the server's business (title/group); history is not a board.
  const before = await digest(thumbFile);
  await writeFile(path.join(scenes, board, "meta.json"), JSON.stringify({ title: "Renamed" }));
  await writeFile(moved, JSON.stringify(scene([rect("c", 0, 50, Date.now())])));
  await sleep(1800);
  check("meta and history writes do not re-render a preview", (await digest(thumbFile)) === before);

  check(
    "the watcher stayed up and reported its work",
    watcher.exitCode === null && /rendering previews/.test(output) && /previews up to date/.test(output),
    output.split("\n").slice(-4).join(" | "),
  );
}

try {
  await main();
} catch (error) {
  results.push({ name: "harness", ok: false, detail: error?.stack || String(error) });
  process.stdout.write(`  ✗ harness\n    ${error?.stack || error}\n`);
} finally {
  if (watcher && watcher.exitCode === null) watcher.kill("SIGTERM");
  if (tmp) await rm(tmp, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok).length;
process.stdout.write(`\nnode scripts/test-preview-watcher.mjs — ${results.length - failed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
