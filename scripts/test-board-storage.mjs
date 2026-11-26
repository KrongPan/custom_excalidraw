#!/usr/bin/env node
/**
 * scripts/test-board-storage.mjs — one run for the per-board folder layout.
 *
 * Proves, against a throwaway DATA_DIR (never gallery/scenes):
 *   create -> save twice -> two snapshots -> newest-first history
 *   -> meta round-trip -> raw /scenes/<id>.excalidraw download
 *   -> a pre-seeded legacy flat board is listed, read and migrated on save
 *   -> DELETE removes the whole folder
 *   -> HISTORY_KEEP prunes oldest-first (a second server with keep=3)
 *   -> gallery/build.mjs --no-render builds a manifest from folder boards
 *
 * Node built-ins only (fetch is global since Node 22); no `excalidraw` CLI.
 *
 *   node scripts/test-board-storage.mjs
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const ROOT = resolve(HERE, "..");
const SERVER = join(ROOT, "app", "server.mjs");
const BUILD = join(ROOT, "gallery", "build.mjs");

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

/* ------------------------------------------------------------------- harness */

let passed = 0;
const failures = [];

async function step(name, fn) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (error) {
    failures.push({ name, error });
    process.stdout.write(`  ✗ ${name}\n    ${error?.message || error}\n`);
  }
}

function listen(server) {
  return new Promise((ok, no) => {
    server.once("error", no);
    server.listen(0, "127.0.0.1", () => ok(server.address().port));
  });
}

async function portFree(port) {
  const probe = createServer();
  try {
    await new Promise((ok, no) => {
      probe.once("error", no);
      probe.listen(port, "127.0.0.1", ok);
    });
    await new Promise((ok) => probe.close(ok));
    return true;
  } catch {
    return false;
  }
}

async function freePort() {
  for (const port of [5801, 5802]) {
    if (await portFree(port)) return port;
  }
  const probe = createServer();
  const port = await listen(probe);
  await new Promise((ok) => probe.close(ok));
  return port;
}

/** Spawn app/server.mjs against `dataDir`, wait for /api/health, return a handle. */
async function startServer(dataDir, extraEnv = {}) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const logs = [];
  const proc = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      APP_DIR: join(dataDir, "app"),
      GALLERY_DIR: join(dataDir, "gallery"),
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (chunk) => logs.push(chunk.toString()));
  proc.stderr.on("data", (chunk) => logs.push(chunk.toString()));

  const stop = async () => {
    if (proc.exitCode !== null) return;
    proc.kill("SIGTERM");
    await Promise.race([new Promise((ok) => proc.once("exit", ok)), sleep(2000)]);
    if (proc.exitCode === null) proc.kill("SIGKILL");
  };

  for (let i = 0; i < 80; i += 1) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return { base, port, proc, logs, stop };
    } catch {
      /* not listening yet */
    }
    await sleep(100);
  }
  await stop();
  throw new Error(`server did not start:\n${logs.join("")}`);
}

async function runBuild(scenesDir, siteDir) {
  const logs = [];
  const proc = spawn(process.execPath, [BUILD, "--no-render"], {
    cwd: ROOT,
    env: { ...process.env, SCENES_DIR: scenesDir, SITE_DIR: siteDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (chunk) => logs.push(chunk.toString()));
  proc.stderr.on("data", (chunk) => logs.push(chunk.toString()));
  const code = await new Promise((ok) => proc.once("exit", ok));
  return { code, logs: logs.join("") };
}

async function api(base, path, init) {
  const res = await fetch(base + path, init);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, headers: res.headers, body, text };
}

/** Directory tree of DATA_DIR — printed so a failure shows what is really on disk. */
async function treeLines(dir, prefix = "") {
  const lines = [];
  let names;
  try {
    names = (await readdir(dir)).sort();
  } catch {
    return lines;
  }
  for (const name of names) {
    const path = join(dir, name);
    const info = await stat(path);
    lines.push(`${prefix}${name}${info.isDirectory() ? "/" : ""}`);
    if (info.isDirectory()) lines.push(...(await treeLines(path, `${prefix}${name}/`)));
  }
  return lines;
}

async function printTree(label) {
  const lines = await treeLines(dataDir);
  process.stdout.write(`\n${label} (${dataDir}):\n${lines.map((line) => `  ${line}`).join("\n")}\n`);
}

const jsonInit = (method, value) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value),
});

const sceneWith = (elements) => ({
  type: "excalidraw",
  version: 2,
  source: "storage-test",
  elements,
  appState: {},
  files: {},
});

const rect = (id, version) => ({ id, type: "rectangle", version, versionNonce: version, x: 0, y: 0, width: 10, height: 10 });

/* ---------------------------------------------------------------------- main */

const root = await mkdtemp(join(tmpdir(), "boards-storage-test-"));
const dataDir = join(root, "data");
await mkdir(dataDir, { recursive: true });

const cleanupDirs = [root];
let server = null;

try {
  /* ---------------------------------------------------------- folder layout */

  server = await startServer(dataDir);
  const { base } = server;
  process.stdout.write(`storage tests — ${base}, DATA_DIR=${dataDir}\n`);

  let id = null;

  await step("POST /api/boards creates <DATA_DIR>/<id>/scene.excalidraw", async () => {
    const res = await api(base, "/api/boards", jsonInit("POST", { name: "scene-test" }));
    assert.equal(res.status, 201);
    id = res.body.id;
    assert.equal(id, "scene-test");
    const scene = await readFile(join(dataDir, id, "scene.excalidraw"), "utf8");
    assert.equal(JSON.parse(scene).type, "excalidraw");
    await assert.rejects(stat(join(dataDir, `${id}.excalidraw`)), "no flat scene file should exist");
  });

  await step("two saves leave two snapshots in <id>/history/", async () => {
    const first = await api(base, `/api/boards/${id}`, jsonInit("PUT", sceneWith([rect("a", 1)])));
    assert.equal(first.status, 200);
    await sleep(10);
    const second = await api(base, `/api/boards/${id}`, jsonInit("PUT", sceneWith([rect("a", 2)])));
    assert.equal(second.status, 200);
    const snapshots = (await readdir(join(dataDir, id, "history"))).filter((f) => f.endsWith(".excalidraw"));
    assert.equal(snapshots.length, 2, `expected 2 snapshots, saw ${snapshots.join(", ")}`);
    const newest = JSON.parse(await readFile(join(dataDir, id, "scene.excalidraw"), "utf8"));
    assert.equal(newest.elements[0].version, 2, "the live scene should be the last save");
    const snap = JSON.parse(await readFile(join(dataDir, id, "history", snapshots.sort()[1]), "utf8"));
    assert.equal(snap.elements[0].version, 1, "a snapshot should hold the previous save");
  });

  await step("GET history is newest-first, keeps 100 by default, leaks no paths", async () => {
    const res = await api(base, `/api/boards/${id}/history`);
    assert.equal(res.status, 200);
    assert.equal(res.body.id, id);
    assert.equal(res.body.keep, 100, "default HISTORY_KEEP should be 100");
    assert.equal(res.body.history.length, 2);
    const [newest, oldest] = res.body.history;
    for (const entry of res.body.history) {
      assert.deepEqual(Object.keys(entry).sort(), ["bytes", "name", "savedAt"]);
      assert.ok(entry.bytes > 0, "snapshot should report its size");
      assert.match(entry.name, /^\d{4}-\d{2}-\d{2}T.*\.excalidraw$/, `unexpected snapshot name ${entry.name}`);
      assert.ok(Date.parse(entry.savedAt) > 0, `unexpected savedAt ${entry.savedAt}`);
    }
    assert.ok(Date.parse(newest.savedAt) >= Date.parse(oldest.savedAt), "history should be newest first");
    assert.ok(!res.text.includes(dataDir), "the response must not contain the data dir");
    assert.ok(!res.text.includes(join(dataDir, id)), "the response must not contain absolute paths");
  });

  await step("PATCH meta round-trips through <id>/meta.json", async () => {
    const res = await api(base, `/api/boards/${id}/meta`, jsonInit("PATCH", { title: "  โครงสร้างใหม่  " }));
    assert.equal(res.status, 200);
    assert.equal(res.body.title, "โครงสร้างใหม่");
    const saved = JSON.parse(await readFile(join(dataDir, id, "meta.json"), "utf8"));
    assert.deepEqual(saved, { title: "โครงสร้างใหม่" });
    const read = await api(base, `/api/boards/${id}/meta`);
    assert.equal(read.body.title, "โครงสร้างใหม่");
    const list = await api(base, "/api/boards");
    assert.equal(list.body.boards.find((board) => board.id === id)?.title, "โครงสร้างใหม่");
  });

  await step("/scenes/<id>.excalidraw serves the scene, history stays private", async () => {
    const res = await api(base, `/scenes/${id}.excalidraw`);
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.text).elements[0].version, 2);
    const onDisk = await fetch(`${base}/scenes/${id}/scene.excalidraw`, { redirect: "manual" });
    assert.equal(onDisk.status, 301);
    assert.equal(onDisk.headers.get("location"), `/scenes/${id}.excalidraw`);
    const history = (await api(base, `/api/boards/${id}/history`)).body.history;
    const leak = await api(base, `/scenes/${id}/history/${history[0].name}`);
    assert.equal(leak.status, 404, "snapshots must not be downloadable");
  });

  /* --------------------------------------------------------------- legacy */

  await step("a pre-seeded legacy flat board is listed and read", async () => {
    await writeFile(join(dataDir, "legacy-board.excalidraw"), `${JSON.stringify(sceneWith([rect("old", 1)]), null, 2)}\n`);
    await writeFile(join(dataDir, "legacy-board.meta.json"), `${JSON.stringify({ title: "Legacy board" }, null, 2)}\n`);
    await mkdir(join(dataDir, ".history", "legacy-board"), { recursive: true });
    await writeFile(
      join(dataDir, ".history", "legacy-board", "2026-01-01T00-00-00-000Z.excalidraw"),
      `${JSON.stringify(sceneWith([]), null, 2)}\n`,
    );

    const list = await api(base, "/api/boards");
    const board = list.body.boards.find((entry) => entry.id === "legacy-board");
    assert.ok(board, "legacy board missing from the list");
    assert.equal(board.title, "Legacy board", "legacy sidecar should still be read");

    const scene = await api(base, "/api/boards/legacy-board");
    assert.equal(scene.status, 200);
    assert.equal(scene.body.elements[0].id, "old");

    const history = await api(base, "/api/boards/legacy-board/history");
    assert.equal(history.status, 200);
    assert.deepEqual(history.body.history.map((entry) => entry.name), ["2026-01-01T00-00-00-000Z.excalidraw"]);

    const raw = await api(base, "/scenes/legacy-board.excalidraw");
    assert.equal(raw.status, 200);
    assert.equal(JSON.parse(raw.text).elements[0].id, "old");
  });

  await step("a save migrates the legacy board into its folder", async () => {
    const res = await api(base, "/api/boards/legacy-board", jsonInit("PUT", sceneWith([rect("new", 3)])));
    assert.equal(res.status, 200, res.text);

    const scene = JSON.parse(await readFile(join(dataDir, "legacy-board", "scene.excalidraw"), "utf8"));
    assert.equal(scene.elements[0].id, "new");
    const meta = JSON.parse(await readFile(join(dataDir, "legacy-board", "meta.json"), "utf8"));
    assert.equal(meta.title, "Legacy board");
    await assert.rejects(stat(join(dataDir, "legacy-board.excalidraw")), "the flat scene should be gone");
    await assert.rejects(stat(join(dataDir, "legacy-board.meta.json")), "the flat sidecar should be gone");
    await assert.rejects(stat(join(dataDir, ".history", "legacy-board")), "the legacy history dir should be gone");

    const snapshots = (await readdir(join(dataDir, "legacy-board", "history"))).sort();
    assert.equal(snapshots.length, 2, `legacy snapshot + save snapshot, saw ${snapshots.join(", ")}`);
    assert.ok(snapshots.includes("2026-01-01T00-00-00-000Z.excalidraw"), "the old snapshot should survive the move");

    const read = await api(base, "/api/boards/legacy-board");
    assert.equal(read.body.elements[0].id, "new");
    const raw = await api(base, "/scenes/legacy-board.excalidraw");
    assert.equal(JSON.parse(raw.text).elements[0].id, "new");
  });

  await printTree("DATA_DIR after the legacy migration");

  /* ---------------------------------------------------------------- delete */

  await step("DELETE removes the whole board folder", async () => {
    const res = await api(base, `/api/boards/${id}`, { method: "DELETE" });
    assert.equal(res.status, 200);
    await assert.rejects(stat(join(dataDir, id)), "the board folder should be gone");
    assert.equal((await api(base, `/api/boards/${id}`)).status, 404);
    assert.equal((await api(base, `/api/boards/${id}/history`)).status, 404);
  });

  await step("a save for a deleted board is refused instead of recreating it", async () => {
    const scene = { type: "excalidraw", version: 2, elements: [], appState: {} };
    const res = await api(base, `/api/boards/${id}`, jsonInit("PUT", scene));
    assert.equal(res.status, 404, "a PUT on a missing board must not create it");
    await assert.rejects(stat(join(dataDir, id)), "the deleted folder should stay deleted");
    assert.equal((await api(base, `/api/boards`)).body.boards.some((b) => b.id === id), false);
  });

  await step("DELETE also clears a never-migrated legacy board", async () => {
    const res = await api(base, "/api/boards/legacy-board", { method: "DELETE" });
    assert.equal(res.status, 200);
    await assert.rejects(stat(join(dataDir, "legacy-board")), "the board folder should be gone");
    await assert.rejects(stat(join(dataDir, ".history", "legacy-board")), "legacy history should be gone");
  });

  await server.stop();
  server = null;

  /* -------------------------------------------------------------- retention */

  await step("HISTORY_KEEP=3 keeps the three newest snapshots", async () => {
    server = await startServer(dataDir, { HISTORY_KEEP: "3" });
    const created = await api(server.base, "/api/boards", jsonInit("POST", { name: "prune-me" }));
    assert.equal(created.status, 201);

    let previous = [];
    for (let version = 1; version <= 5; version += 1) {
      await sleep(10);
      const saved = await api(server.base, `/api/boards/${created.body.id}`, jsonInit("PUT", sceneWith([rect("a", version)])));
      assert.equal(saved.status, 200);
      previous = (await api(server.base, `/api/boards/${created.body.id}/history`)).body.history.map((entry) => entry.name);
    }

    const history = await api(server.base, `/api/boards/${created.body.id}/history`);
    assert.equal(history.body.keep, 3);
    assert.equal(history.body.history.length, 3, `expected 3 snapshots, saw ${history.body.history.length}`);
    assert.deepEqual(
      history.body.history.map((entry) => entry.name),
      previous.slice(0, 3),
      "the kept snapshots should be the newest three",
    );
    assert.deepEqual(
      (await readdir(join(dataDir, "prune-me", "history"))).filter((f) => f.endsWith(".excalidraw")).length,
      3,
      "the pruned snapshots should be gone from disk",
    );
  });

  await server.stop();
  server = null;
} catch (error) {
  failures.push({ name: "harness", error });
  process.stdout.write(`  ✗ harness\n    ${error?.message || error}\n`);
} finally {
  if (server) await server.stop();
}

/* --------------------------------------------------------------- gallery */

try {
  const scenesDir = join(root, "scenes");
  const siteDir = join(root, "site");
  const folderScene = sceneWith([rect("folder", 1)]);
  await mkdir(join(scenesDir, "folder-board"), { recursive: true });
  await mkdir(join(scenesDir, "folder-board", "history"), { recursive: true });
  await writeFile(join(scenesDir, "folder-board", "scene.excalidraw"), `${JSON.stringify(folderScene, null, 2)}\n`);
  await writeFile(join(scenesDir, "folder-board", "meta.json"), `${JSON.stringify({ title: "Folder board", subtitle: "ใหม่" }, null, 2)}\n`);
  await writeFile(
    join(scenesDir, "folder-board", "history", "2026-01-01T00-00-00-000Z.excalidraw"),
    `${JSON.stringify(sceneWith([]), null, 2)}\n`,
  );
  await writeFile(join(scenesDir, "legacy-flat.excalidraw"), `${JSON.stringify(sceneWith([rect("flat", 1)]), null, 2)}\n`);

  await step("gallery/build.mjs --no-render reads the folder layout", async () => {
    const result = await runBuild(scenesDir, siteDir);
    assert.equal(result.code, 0, result.logs);
    const manifest = JSON.parse(await readFile(join(siteDir, "manifest.json"), "utf8"));
    assert.equal(manifest.boards.length, 2, `expected 2 boards, saw ${manifest.boards.length}`);
    const folder = manifest.boards.find((board) => board.id === "folder-board");
    assert.ok(folder, "the folder board should be in the manifest");
    assert.equal(folder.title, "Folder board");
    assert.equal(folder.subtitle, "ใหม่");
    assert.equal(folder.elements, 1);
    assert.ok(manifest.boards.some((board) => board.id === "legacy-flat"), "the legacy flat board should still be catalogued");
    assert.ok(!manifest.boards.some((board) => board.slug.includes("2026")), "history snapshots must not be catalogued");
    const copy = await readFile(join(siteDir, "scenes", `${folder.slug}.excalidraw`), "utf8");
    assert.equal(JSON.parse(copy).elements[0].id, "folder");
    assert.ok(!JSON.stringify(manifest).includes(scenesDir), "the manifest must not contain absolute paths");
  });

  await printTree("DATA_DIR after the scenario (folder boards deleted, retention board left)");
} catch (error) {
  failures.push({ name: "gallery", error });
  process.stdout.write(`  ✗ gallery\n    ${error?.message || error}\n`);
}

for (const dir of cleanupDirs) await rm(dir, { recursive: true, force: true });

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const { name, error } of failures) process.stdout.write(`\nFAILED: ${name}\n${error?.stack || error}\n`);
  process.exit(1);
}
