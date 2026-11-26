#!/usr/bin/env node
/**
 * scripts/test-board-meta.mjs — end-to-end tests for the board meta API.
 *
 * Spawns app/server.mjs on a random port with a throwaway DATA_DIR under the
 * system temp folder, so it never touches the live container or gallery/scenes.
 *
 *   node scripts/test-board-meta.mjs
 *
 * Uses only Node built-ins (fetch + WebSocket are global since Node 22), so it
 * needs no dependencies and does not read node_modules.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const ROOT = resolve(HERE, "..");
const SERVER = join(ROOT, "app", "server.mjs");

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function freePort() {
  return new Promise((ok, no) => {
    const probe = createServer();
    probe.on("error", no);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => ok(port));
    });
  });
}

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

/* --------------------------------------------------------------------- main */

const dataDir = await mkdtemp(join(tmpdir(), "boards-meta-test-"));
const appDir = join(dataDir, "app");
const galleryDir = join(dataDir, "gallery");
const port = await freePort();
const base = `http://127.0.0.1:${port}`;

const logs = [];
const server = spawn(process.execPath, [SERVER], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(port),
    DATA_DIR: dataDir,
    APP_DIR: appDir,
    GALLERY_DIR: galleryDir,
    HISTORY_KEEP: "3",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (chunk) => logs.push(chunk.toString()));
server.stderr.on("data", (chunk) => logs.push(chunk.toString()));

const cleanup = async () => {
  if (server.exitCode === null) {
    server.kill("SIGTERM");
    await Promise.race([new Promise((ok) => server.once("exit", ok)), sleep(2000)]);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  await rm(dataDir, { recursive: true, force: true });
};

const api = async (path, init) => {
  const res = await fetch(base + path, init);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
};

const patchJson = (id, value) =>
  api(`/api/boards/${encodeURIComponent(id)}/meta`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: typeof value === "string" ? value : JSON.stringify(value),
  });

try {
  // wait for the server to answer /api/health
  let up = false;
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) {
        up = true;
        break;
      }
    } catch {
      /* not listening yet */
    }
    await sleep(100);
  }
  if (!up) throw new Error(`server did not start:\n${logs.join("")}`);

  process.stdout.write(`meta API tests — ${base}, DATA_DIR=${dataDir}\n`);

  let id = null;

  await step("POST /api/boards creates a board", async () => {
    const res = await api("/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "meta-test" }),
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.id, "meta-test");
    id = res.body.id;
  });

  await step("GET meta falls back to the board id", async () => {
    const res = await api(`/api/boards/${id}/meta`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { id, title: id, subtitle: "", tags: [], groupId: null, groupIds: [] });
  });

  await step("PATCH meta trims the title and persists the sidecar", async () => {
    const res = await patchJson(id, { title: "  Test board  " });
    assert.equal(res.status, 200);
    assert.equal(res.body.title, "Test board");
    const saved = JSON.parse(await readFile(join(dataDir, id, "meta.json"), "utf8"));
    assert.deepEqual(saved, { title: "Test board" });
  });

  await step("GET /api/boards reports the new title", async () => {
    const res = await api("/api/boards");
    assert.equal(res.status, 200);
    const board = res.body.boards.find((b) => b.id === id);
    assert.ok(board, "board missing from the list");
    assert.equal(board.title, "Test board");
  });

  await step("PATCH only the title keeps subtitle and tags", async () => {
    await writeFile(
      join(dataDir, id, "meta.json"),
      `${JSON.stringify({ title: "Old", subtitle: "คำอธิบาย", tags: ["a", "b"] }, null, 2)}\n`,
    );
    const res = await patchJson(id, { title: "Renamed" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { id, title: "Renamed", subtitle: "คำอธิบาย", tags: ["a", "b"], groupId: null, groupIds: [] });
    const saved = JSON.parse(await readFile(join(dataDir, id, "meta.json"), "utf8"));
    assert.deepEqual(saved, { title: "Renamed", subtitle: "คำอธิบาย", tags: ["a", "b"] });
  });

  await step("a blank title clears the custom name (extras keep the sidecar)", async () => {
    const res = await patchJson(id, { title: "   " });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { id, title: id, subtitle: "คำอธิบาย", tags: ["a", "b"], groupId: null, groupIds: [] });
    const saved = JSON.parse(await readFile(join(dataDir, id, "meta.json"), "utf8"));
    assert.deepEqual(saved, { subtitle: "คำอธิบาย", tags: ["a", "b"] });
  });

  await step("a blank title removes an otherwise empty sidecar", async () => {
    await writeFile(join(dataDir, id, "meta.json"), `${JSON.stringify({ title: "Only" }, null, 2)}\n`);
    const res = await patchJson(id, { title: "" });
    assert.equal(res.status, 200);
    assert.equal(res.body.title, id);
    await assert.rejects(stat(join(dataDir, id, "meta.json")), "sidecar should be gone");
  });

  await step("121 code points → 400, 120 → 200", async () => {
    const tooLong = await patchJson(id, { title: "ก".repeat(121) });
    assert.equal(tooLong.status, 400);
    const okLength = await patchJson(id, { title: "ก".repeat(120) });
    assert.equal(okLength.status, 200);
    assert.equal([...okLength.body.title].length, 120);
  });

  await step("malformed / non-string / non-object bodies → 400", async () => {
    assert.equal((await patchJson(id, "{not json")).status, 400);
    assert.equal((await patchJson(id, { title: 42 })).status, 400);
    assert.equal((await patchJson(id, { nope: true })).status, 400);
    assert.equal((await patchJson(id, "null")).status, 400);
    assert.equal((await patchJson(id, "[]")).status, 400);
  });

  await step("unknown board → 404 for GET and PATCH", async () => {
    assert.equal((await api("/api/boards/nope/meta")).status, 404);
    assert.equal((await patchJson("nope", { title: "x" })).status, 404);
  });

  await step("other methods → 405", async () => {
    const res = await api(`/api/boards/${id}/meta`, { method: "DELETE" });
    assert.equal(res.status, 405);
  });

  await step("PATCH broadcasts {type:'meta'} to the board room", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/board/${encodeURIComponent(id)}`);
    const messages = [];
    const received = new Promise((ok, no) => {
      const timer = setTimeout(() => no(new Error("no meta broadcast within 3s")), 3000);
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data));
        messages.push(message.type);
        if (message.type === "meta") {
          clearTimeout(timer);
          ok(message);
        }
      };
      socket.onerror = () => {
        clearTimeout(timer);
        no(new Error("websocket error"));
      };
    });
    await new Promise((ok, no) => {
      if (socket.readyState === 1) return ok();
      socket.onopen = () => ok();
      socket.onerror = () => no(new Error("websocket refused"));
      setTimeout(() => no(new Error("websocket did not open")), 3000);
    });
    const res = await patchJson(id, { title: "Live rename" });
    assert.equal(res.status, 200);
    const broadcast = await received;
    socket.close();
    assert.deepEqual(broadcast, {
      type: "meta",
      id,
      title: "Live rename",
      subtitle: "",
      tags: [],
      groupId: null,
      groupIds: [],
    });
    assert.ok(messages.includes("meta"));
  });

  await step("the scene file is untouched by meta writes", async () => {
    const scene = JSON.parse(await readFile(join(dataDir, id, "scene.excalidraw"), "utf8"));
    assert.equal(scene.type, "excalidraw");
    assert.ok(Array.isArray(scene.elements));
  });
} catch (error) {
  failures.push({ name: "harness", error });
  process.stdout.write(`  ✗ harness\n    ${error?.message || error}\n`);
} finally {
  await cleanup();
}

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const { name, error } of failures) process.stdout.write(`\nFAILED: ${name}\n${error?.stack || error}\n`);
  process.exit(1);
}
