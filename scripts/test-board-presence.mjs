#!/usr/bin/env node
/**
 * scripts/test-board-presence.mjs — presence / reload / heartbeat tests.
 *
 * Spawns app/server.mjs on a random port with a throwaway DATA_DIR under the
 * system temp folder, so it never touches the live container or gallery/scenes.
 * The heartbeat is shortened with HEARTBEAT_MS so the sweep is observable.
 *
 *   node scripts/test-board-presence.mjs
 *
 * Uses only Node built-ins (fetch, WebSocket, net), so it needs no dependencies.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const ROOT = resolve(HERE, "..");
const SERVER = join(ROOT, "app", "server.mjs");
const HEARTBEAT_MS = 300;

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

/* ------------------------------------------------------------------ clients */

/** A board socket that records every frame and can wait for a predicate. */
function connectBoard(port, id, { sid, name } = {}) {
  const params = new URLSearchParams();
  if (name) params.set("name", name);
  if (sid) params.set("sid", sid);
  const query = params.toString();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/board/${encodeURIComponent(id)}${query ? `?${query}` : ""}`);
  const state = { ws, messages: [], peers: null, you: null, closeInfo: null, maxPeers: 0 };

  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    state.messages.push(message);
    if (message.type === "welcome") state.you = message.you;
    if (message.type === "presence") {
      state.peers = message.peers;
      state.maxPeers = Math.max(state.maxPeers, message.peers.length);
    }
  };
  ws.onclose = (event) => {
    state.closeInfo = { code: event.code, reason: event.reason };
  };

  state.opened = new Promise((ok, no) => {
    ws.onopen = () => ok(state);
    ws.onerror = () => no(new Error("websocket error"));
  });

  state.waitFor = async (predicate, label, timeout = 6000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (predicate(state)) return true;
      await sleep(20);
    }
    throw new Error(`timeout waiting for ${label}`);
  };

  state.close = () =>
    new Promise((ok) => {
      if (ws.readyState === 3) return ok();
      ws.onclose = (event) => {
        state.closeInfo = { code: event.code, reason: event.reason };
        ok();
      };
      ws.close();
    });

  return state;
}

/**
 * A socket that answers the handshake and then goes silent: no pong frames, the
 * way a laptop that lost its network behaves. Only the server sweep can notice.
 */
function silentSocket(port, id) {
  return new Promise((ok, no) => {
    const key = randomBytes(16).toString("base64");
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        `GET /ws/board/${encodeURIComponent(id)} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    let buffer = "";
    const done = (fn, value) => {
      socket.removeAllListeners("data");
      fn(value);
    };
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      if (buffer.includes("\r\n\r\n")) {
        const status = buffer.split("\r\n")[0];
        done(ok, { socket, status, closed: new Promise((res) => socket.once("close", () => res(true))) });
      }
    });
    socket.on("close", () => done(no, new Error("closed before the handshake finished")));
    socket.on("error", (error) => done(no, error));
    socket.setTimeout(8000, () => done(no, new Error("handshake timeout")));
  });
}

/* --------------------------------------------------------------------- main */

const dataDir = await mkdtemp(join(tmpdir(), "boards-presence-test-"));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;

const logs = [];
const server = spawn(process.execPath, [SERVER], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(port),
    DATA_DIR: dataDir,
    APP_DIR: join(dataDir, "app"),
    GALLERY_DIR: join(dataDir, "gallery"),
    HEARTBEAT_MS: String(HEARTBEAT_MS),
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

const streams = [];
try {
  let up = false;
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) {
        up = true;
        break;
      }
    } catch {
      /* not listening yet */
    }
    await sleep(100);
  }
  if (!up) throw new Error(`server did not start:\n${logs.join("")}`);

  process.stdout.write(`presence tests — ${base}, HEARTBEAT_MS=${HEARTBEAT_MS}\n`);

  const created = await api("/api/boards", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "presence-test" }),
  });
  assert.equal(created.status, 201);
  const id = created.body.id;

  const observer = connectBoard(port, id, { sid: "observer-sid-01", name: "observer" });
  streams.push(observer);
  await observer.opened;
  await observer.waitFor((s) => s.peers?.length === 1, "observer alone in the room");
  const track = (client) => {
    streams.push(client);
    return client;
  };

  await step("one socket = one peer", () => {
    assert.equal(observer.peers.length, 1);
    assert.equal(observer.messages.filter((m) => m.type === "presence").length >= 1, true);
  });

  await step("a second tab counts separately", async () => {
    const other = track(connectBoard(port, id, { sid: "tab-one-0001", name: "tab one" }));
    await other.opened;
    await other.waitFor((s) => s.you !== null, "the second tab's welcome");
    await observer.waitFor((s) => s.peers?.length === 2, "two peers");
    assert.notEqual(other.you.id, observer.you.id);
  });

  await step("the same sid closes the previous socket with 4001 and keeps one peer", async () => {
    const first = connectBoard(port, id, { sid: "tab-reload-0001", name: "reload" });
    await first.opened;
    await observer.waitFor((s) => s.peers?.length === 3, "three peers with the reload tab");

    const second = connectBoard(port, id, { sid: "tab-reload-0001", name: "reload" });
    await second.opened;
    await second.waitFor((s) => s.you !== null, "the replacement's welcome");
    await first.waitFor((s) => s.closeInfo !== null, "the old socket to be closed");
    assert.equal(first.closeInfo.code, 4001);
    assert.equal(first.closeInfo.reason, "replaced");
    await observer.waitFor((s) => s.peers?.length === 3, "still three peers after the swap");
    assert.ok(observer.peers.some((p) => p.id === second.you.id));
    assert.ok(!observer.peers.some((p) => p.id === first.you.id));
    await first.close().catch(() => {});
    await second.close();
    await observer.waitFor((s) => s.peers?.length === 2, "back to two peers");
  });

  await step("five reloads do not grow the room", async () => {
    let current = null;
    for (let i = 0; i < 5; i += 1) {
      const next = connectBoard(port, id, { sid: "tab-loop-0001", name: `loop ${i}` });
      await next.opened;
      await observer.waitFor((s) => s.peers?.length === 3, `three peers after reload ${i}`);
      if (current) {
        await current.waitFor((s) => s.closeInfo !== null, `old socket closed on reload ${i}`);
        assert.equal(current.closeInfo.code, 4001);
      }
      current = next;
    }
    assert.equal(observer.maxPeers, 3, `the room never grew past 3, saw ${observer.maxPeers}`);
    await current.close();
    await observer.waitFor((s) => s.peers?.length === 2, "back to two peers after the loop");
  });

  await step("a normal close removes the peer", async () => {
    const guest = connectBoard(port, id, { sid: "tab-close-0001", name: "closing" });
    await guest.opened;
    await observer.waitFor((s) => s.peers?.length === 3, "three peers");
    await guest.close();
    await observer.waitFor((s) => s.peers?.length === 2, "peer removed on close");
  });

  await step("an invalid sid is ignored, not fatal", async () => {
    const a = connectBoard(port, id, { sid: "bad sid!", name: "bad a" });
    const b = connectBoard(port, id, { sid: "bad sid!", name: "bad b" });
    await a.opened;
    await b.opened;
    await a.waitFor((s) => s.you !== null, "the first malformed-sid welcome");
    await b.waitFor((s) => s.you !== null, "the second malformed-sid welcome");
    await observer.waitFor((s) => s.peers?.length === 4, "both malformed-sid sockets stay");
    assert.notEqual(a.you.id, b.you.id);
    await a.close();
    await b.close();
    await observer.waitFor((s) => s.peers?.length === 2, "back to two peers");
  });

  await step("saving still works over the socket", async () => {
    const writer = connectBoard(port, id, { sid: "tab-save-0001", name: "writer" });
    await writer.opened;
    const scene = {
      type: "excalidraw",
      version: 2,
      source: "presence-test",
      elements: [{ id: "el1", type: "rectangle", version: 1, versionNonce: 1 }],
      appState: {},
      files: {},
    };
    writer.ws.send(JSON.stringify({ type: "update", scene }));
    await writer.waitFor((s) => s.messages.some((m) => m.type === "saved"), "the save confirmation");
    const saved = JSON.parse(await readFile(join(dataDir, id, "scene.excalidraw"), "utf8"));
    assert.equal(saved.elements.length, 1);
    assert.equal(saved.elements[0].id, "el1");
    await writer.close();
    await observer.waitFor((s) => s.peers?.length === 2, "back to two peers");
  });

  await step("a laser pointer frame is relayed with its tool and button", async () => {
    const sender = connectBoard(port, id, { sid: "tab-laser-0001", name: "laser" });
    await sender.opened;
    await sender.waitFor((s) => s.you !== null, "the laser sender's welcome");
    const mark = observer.messages.length;
    sender.ws.send(JSON.stringify({ type: "pointer", x: 120.5, y: -40, tool: "laser", button: "down" }));
    await observer.waitFor(
      (s) => s.messages.slice(mark).some((m) => m.type === "pointer" && m.x === 120.5),
      "the relayed laser frame",
    );
    const frame = observer.messages.slice(mark).find((m) => m.type === "pointer" && m.x === 120.5);
    assert.equal(frame.y, -40);
    assert.equal(frame.tool, "laser");
    assert.equal(frame.button, "down");
    assert.equal(frame.from, sender.you.id);
    assert.equal(typeof frame.color, "string");

    const released = observer.messages.length;
    sender.ws.send(JSON.stringify({ type: "pointer", x: 121, y: -39, tool: "laser", button: "up" }));
    await observer.waitFor(
      (s) => s.messages.slice(released).some((m) => m.type === "pointer" && m.button === "up"),
      "the released laser frame",
    );
    await sender.close();
  });

  await step("a pointer frame without a tool reads as the cursor", async () => {
    const sender = connectBoard(port, id, { sid: "tab-pointer-001", name: "pointer" });
    await sender.opened;
    const mark = observer.messages.length;
    sender.ws.send(JSON.stringify({ type: "pointer", x: 7, y: 8 }));
    await observer.waitFor(
      (s) => s.messages.slice(mark).some((m) => m.type === "pointer" && m.x === 7),
      "the plain pointer frame",
    );
    const frame = observer.messages.slice(mark).find((m) => m.type === "pointer" && m.x === 7);
    assert.equal(frame.tool, "pointer");
    assert.equal(frame.button, "up");
    await sender.close();
  });

  await step("a malformed pointer frame is dropped and keeps the socket", async () => {
    const sender = connectBoard(port, id, { sid: "tab-badptr-001", name: "bad pointer" });
    await sender.opened;
    const mark = observer.messages.length;
    sender.ws.send(JSON.stringify({ type: "pointer", x: "left", y: 2, tool: "laser", button: "down" }));
    sender.ws.send(JSON.stringify({ type: "pointer" }));
    await sleep(250);
    assert.equal(observer.messages.slice(mark).filter((m) => m.type === "pointer").length, 0);
    assert.equal(sender.ws.readyState, 1);
    await sender.close();
  });

  await step("heartbeat drops a socket that stops answering", async () => {
    const silent = await silentSocket(port, id);
    assert.match(silent.status, /101 Switching Protocols/);
    await observer.waitFor((s) => s.peers?.length === 3, "the silent socket joins the room");
    const dropped = await Promise.race([
      silent.closed.then(() => true),
      sleep(4000).then(() => false),
    ]);
    assert.equal(dropped, true, "the silent socket should be terminated by the heartbeat");
    await observer.waitFor((s) => s.peers?.length === 2, "the dead peer leaves the presence");
  });

  await step("the room empties when everybody leaves", async () => {
    assert.equal(observer.peers.length, 2);
  });
} catch (error) {
  failures.push({ name: "harness", error });
  process.stdout.write(`  ✗ harness\n    ${error?.message || error}\n`);
} finally {
  for (const client of streams) await client.close().catch(() => {});
  await cleanup();
}

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const { name, error } of failures) process.stdout.write(`\nFAILED: ${name}\n${error?.stack || error}\n`);
  process.exit(1);
}
