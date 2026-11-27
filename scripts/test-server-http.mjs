#!/usr/bin/env node
/**
 * scripts/test-server-http.mjs — the wire behaviour of app/server.mjs.
 *
 * Spawns app/server.mjs on a random port with a throwaway DATA_DIR under the
 * system temp folder (never the live container or gallery/scenes) and checks:
 *
 *   compression    brotli/gzip negotiation, Vary, what stays uncompressed,
 *                  build-time .br/.gz sidecars and their staleness rule
 *   304            ETag + Last-Modified on html/thumbs/fonts, If-None-Match
 *   temp sweep     abandoned scene.excalidraw.tmp-* files, at boot and on save
 *   count cache    /api/boards element counts follow the scene's mtime
 *
 *   node scripts/test-server-http.mjs
 *
 * Uses only Node built-ins, so it needs no dependencies of its own. Raw http is
 * used on purpose: fetch would decompress the body and hide the transfer size.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import http from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, brotliDecompressSync, gunzipSync } from "node:zlib";

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const ROOT = resolve(HERE, "..");
const SERVER = join(ROOT, "app", "server.mjs");
const E2E = join(ROOT, "scripts", "e2e-ui.mjs");

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

/* ------------------------------------------------------------------ fixtures */

const root = await mkdtemp(join(tmpdir(), "boards-http-test-"));
const dataDir = join(root, "data");
const appDir = join(root, "app");
const galleryDir = join(root, "gallery");
const boardDir = join(dataDir, "board-a");
const OLD = new Date(Date.now() - 11 * 60 * 1000); // past the 10-minute sweep age

/** A scene the server will list: three live elements and one deleted. */
function sceneWith(live, deleted = 1) {
  const elements = [];
  for (let i = 0; i < live; i += 1) elements.push({ id: `live-${i}`, type: "rectangle", x: i * 10, y: 0, width: 80, height: 40 });
  for (let i = 0; i < deleted; i += 1) elements.push({ id: `gone-${i}`, type: "rectangle", isDeleted: true });
  return { type: "excalidraw", version: 2, elements, appState: {} };
}

const sceneText = (live, deleted = 1) => `${JSON.stringify(sceneWith(live, deleted), null, 2)}\n`;

/* Text that compresses well and is big enough to be worth a dictionary. */
const repeat = (line, times) => Array.from({ length: times }, () => line).join("\n");
const html = `<!doctype html><html lang="th"><title>คลังบอร์ด</title><body>\n${repeat(
  '<article class="card"><h2>board</h2><p>รายละเอียดบอร์ด</p></article>',
  900,
)}\n</body></html>`;
const entryJs = `/* entry */\n${repeat('const fn = (value) => value + "padding-padding";', 3000)}\n`;

await mkdir(join(appDir, "assets"), { recursive: true });
await mkdir(join(appDir, "fonts"), { recursive: true });
await mkdir(join(galleryDir, "thumbs"), { recursive: true });
await mkdir(boardDir, { recursive: true });
await writeFile(join(appDir, "assets", "entry-abc123.js"), entryJs);
await writeFile(join(appDir, "fonts", "Assistant-Regular.woff2"), Buffer.alloc(4096, 7));
await writeFile(join(appDir, "index.html"), "<!doctype html><div id=root></div>\n");
await writeFile(join(appDir, "tiny.css"), ".a{color:#fff}\n");
await writeFile(join(galleryDir, "index.html"), html);
await writeFile(join(galleryDir, "thumbs", "board-a.png"), Buffer.alloc(3072, 9));
await writeFile(join(galleryDir, "manifest.json"), JSON.stringify({ boards: ["board-a"] }));
await writeFile(join(boardDir, "scene.excalidraw"), sceneText(3));
await writeFile(join(boardDir, "meta.json"), JSON.stringify({ title: "บอร์ดทดสอบ" }));
// abandoned atomic-write leftovers: one stale (must go at boot), one fresh
await writeFile(join(boardDir, "scene.excalidraw.tmp-4242-stale"), "half a scene");
await utimes(join(boardDir, "scene.excalidraw.tmp-4242-stale"), OLD, OLD);
await writeFile(join(boardDir, "scene.excalidraw.tmp-4242-fresh"), "being written right now");

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
    BUILD_COMMIT: "test1234",
    BUILD_DATE: "2026-11-28",
    GALLERY_BUILD: "",
  },
});
server.stdout.on("data", (chunk) => logs.push(String(chunk)));
server.stderr.on("data", (chunk) => logs.push(String(chunk)));

/** Raw HTTP: no automatic decompression, so the transfer size stays visible. */
function raw(pathname, headers = {}) {
  return new Promise((ok, no) => {
    const req = http.request({ host: "127.0.0.1", port, path: pathname, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", no);
    req.end();
  });
}

async function apiJson(pathname, init) {
  const response = await fetch(`${base}${pathname}`, init);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

let up = false;
for (let i = 0; i < 100 && !up; i += 1) {
  try {
    await fetch(`${base}/api/health`);
    up = true;
  } catch {
    await sleep(100);
  }
}

try {
  if (!up) throw new Error(`server did not answer on ${base}\n${logs.join("")}`);

  /* ------------------------------------------------------------- compression */

  process.stdout.write("\ncompression\n");

  await step("brotli is preferred when the client offers it", async () => {
    const rawJs = Buffer.byteLength(entryJs);
    const response = await raw("/assets/entry-abc123.js", { "accept-encoding": "gzip, deflate, br" });
    assert.equal(response.status, 200);
    assert.equal(response.headers["content-encoding"], "br");
    assert.equal(response.headers.vary, "Accept-Encoding");
    assert.ok(response.body.length < rawJs / 2, `brotli ${response.body.length} vs raw ${rawJs}`);
    assert.equal(response.body.length, Number(response.headers["content-length"]));
    assert.equal(brotliDecompressSync(response.body).toString(), entryJs);
  });

  await step("gzip when brotli is not offered", async () => {
    const response = await raw("/assets/entry-abc123.js", { "accept-encoding": "gzip, deflate" });
    assert.equal(response.headers["content-encoding"], "gzip");
    assert.equal(gunzipSync(response.body).toString(), entryJs);
  });

  await step("nothing is compressed without Accept-Encoding", async () => {
    const response = await raw("/assets/entry-abc123.js");
    assert.equal(response.headers["content-encoding"], undefined);
    assert.equal(response.body.length, Buffer.byteLength(entryJs));
  });

  await step("q=0 opts brotli out", async () => {
    const response = await raw("/assets/entry-abc123.js", { "accept-encoding": "br;q=0, gzip" });
    assert.equal(response.headers["content-encoding"], "gzip");
  });

  await step("a heavier gzip weight wins over brotli", async () => {
    const response = await raw("/assets/entry-abc123.js", { "accept-encoding": "br;q=0.5, gzip" });
    assert.equal(response.headers["content-encoding"], "gzip");
  });

  await step("the catalogue html is compressed too", async () => {
    const response = await raw("/", { "accept-encoding": "br" });
    assert.equal(response.status, 200);
    assert.equal(response.headers["content-encoding"], "br");
    assert.equal(brotliDecompressSync(response.body).toString(), html);
  });

  await step("png is never compressed", async () => {
    const response = await raw("/gallery/thumbs/board-a.png", { "accept-encoding": "br, gzip" });
    assert.equal(response.headers["content-encoding"], undefined);
    assert.equal(response.body.length, 3072);
  });

  await step("woff2 is never compressed", async () => {
    const response = await raw("/fonts/Assistant-Regular.woff2", { "accept-encoding": "br, gzip" });
    assert.equal(response.headers["content-encoding"], undefined);
    assert.equal(response.body.length, 4096);
  });

  await step("a file under the size floor stays raw", async () => {
    const response = await raw("/tiny.css", { "accept-encoding": "br" });
    assert.equal(response.headers["content-encoding"], undefined);
  });

  await step("a build-time .br sidecar is served as-is", async () => {
    const marker = repeat("SIDECAR-CONTENT ", 400);
    const file = join(appDir, "assets", "side.js");
    await writeFile(file, repeat("const original = 1;", 400));
    await writeFile(`${file}.br`, brotliCompressSync(Buffer.from(marker)));
    const response = await raw("/assets/side.js", { "accept-encoding": "br" });
    assert.equal(response.headers["content-encoding"], "br");
    assert.equal(brotliDecompressSync(response.body).toString(), marker);
  });

  await step("a sidecar older than its source is ignored", async () => {
    const file = join(appDir, "assets", "stale.js");
    const source = repeat("const fresh = 2;", 400);
    await writeFile(file, source);
    await writeFile(`${file}.br`, brotliCompressSync(Buffer.from("STALE")));
    await utimes(file, new Date(), new Date(Date.now() + 1000));
    const response = await raw("/assets/stale.js", { "accept-encoding": "br" });
    assert.equal(brotliDecompressSync(response.body).toString(), source);
  });

  /* ---------------------------------------------------- conditional requests */

  process.stdout.write("\nconditional requests\n");

  let homeEtag = "";

  await step("gallery html carries an ETag and Last-Modified", async () => {
    const response = await raw("/");
    homeEtag = String(response.headers.etag || "");
    assert.match(homeEtag, /^W\/"[0-9a-z]+-[0-9a-z]+"$/);
    assert.ok(!Number.isNaN(Date.parse(response.headers["last-modified"])), "Last-Modified is not a date");
  });

  await step("If-None-Match answers 304 with no body", async () => {
    const response = await raw("/", { "if-none-match": homeEtag });
    assert.equal(response.status, 304);
    assert.equal(response.body.length, 0);
  });

  await step("an unknown ETag still gets the body", async () => {
    const response = await raw("/", { "if-none-match": 'W/"0-0"' });
    assert.equal(response.status, 200);
    assert.ok(response.body.length > 1000);
  });

  await step("the same 304 works when brotli is requested", async () => {
    const response = await raw("/", { "accept-encoding": "br", "if-none-match": homeEtag });
    assert.equal(response.status, 304);
    assert.equal(response.headers["content-encoding"], undefined);
  });

  await step("thumbnails revalidate", async () => {
    const first = await raw("/gallery/thumbs/board-a.png");
    assert.ok(first.headers.etag, "thumbnail has no ETag");
    const again = await raw("/gallery/thumbs/board-a.png", { "if-none-match": String(first.headers.etag) });
    assert.equal(again.status, 304);
  });

  await step("fonts revalidate", async () => {
    const first = await raw("/fonts/Assistant-Regular.woff2");
    assert.ok(first.headers.etag, "font has no ETag");
    const again = await raw("/fonts/Assistant-Regular.woff2", { "if-none-match": String(first.headers.etag) });
    assert.equal(again.status, 304);
  });

  await step("hashed /assets stay immutable and skip validators", async () => {
    const response = await raw("/assets/entry-abc123.js");
    assert.match(String(response.headers["cache-control"]), /immutable/);
    assert.equal(response.headers.etag, undefined);
  });

  await step("a rewritten file gets a new ETag", async () => {
    const file = join(galleryDir, "index.html");
    await writeFile(file, `${html}\n<!-- v2 -->`);
    await utimes(file, new Date(), new Date(Date.now() + 2000));
    const response = await raw("/", { "if-none-match": homeEtag });
    assert.equal(response.status, 200);
    assert.notEqual(response.headers.etag, homeEtag);
  });

  /* ------------------------------------------------------------- temp sweep */

  process.stdout.write("\ntemp sweep\n");

  await step("boot removed the stale temp and kept the live one", async () => {
    assert.equal(existsSync(join(boardDir, "scene.excalidraw.tmp-4242-stale")), false);
    assert.equal(existsSync(join(boardDir, "scene.excalidraw.tmp-4242-fresh")), true);
  });

  await step("a save removes an abandoned temp first", async () => {
    const stale = join(boardDir, "scene.excalidraw.tmp-4242-stale2");
    const foreign = join(boardDir, "scene.excalidraw.tmpX-4242-other");
    const unrelated = join(boardDir, "meta.tmp-4242-old");
    for (const file of [stale, foreign, unrelated]) {
      await writeFile(file, "leftover");
      await utimes(file, OLD, OLD);
    }
    const saved = await apiJson("/api/boards/board-a", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sceneWith(2)),
    });
    assert.equal(saved.status, 200);
    assert.equal(existsSync(stale), false, "stale temp survived the save");
    assert.equal(existsSync(foreign), true, "a file outside the exact prefix was deleted");
    assert.equal(existsSync(unrelated), true, "an unrelated temp was deleted");
    await rm(foreign);
    await rm(unrelated);
  });

  /* ------------------------------------------------------------ count cache */

  process.stdout.write("\ncount cache\n");

  const sceneFile = join(boardDir, "scene.excalidraw");
  const stamped = new Date(Date.now() - 60_000);

  await step("/api/boards counts the live elements", async () => {
    await utimes(sceneFile, stamped, stamped);
    const listed = await apiJson("/api/boards");
    const board = listed.body.boards.find((item) => item.id === "board-a");
    assert.ok(board, "board-a is missing from /api/boards");
    assert.equal(board.elements, 2);
  });

  await step("an unchanged mtime is served from the cache", async () => {
    // same mtime, different content: only a cache hit can still report 2
    await writeFile(sceneFile, sceneText(1));
    await utimes(sceneFile, stamped, stamped);
    const listed = await apiJson("/api/boards");
    assert.equal(listed.body.boards.find((item) => item.id === "board-a").elements, 2);
  });

  await step("a touched scene is re-read", async () => {
    const touched = new Date(stamped.getTime() + 5000);
    await utimes(sceneFile, touched, touched);
    const listed = await apiJson("/api/boards");
    assert.equal(listed.body.boards.find((item) => item.id === "board-a").elements, 1);
  });

  /* ----------------------------------------------------------------- health */

  process.stdout.write("\nhealth\n");

  await step("/api/health reports the build stamp", async () => {
    const health = await apiJson("/api/health");
    assert.equal(health.body.ok, true);
    assert.equal(health.body.commit, "test1234");
    assert.equal(health.body.date, "2026-11-28");
    assert.equal(health.body.dataDir, dataDir);
  });

  /* --------------------------------------------------------------- e2e guard */

  process.stdout.write("\ne2e guard\n");

  await step("e2e-ui refuses a data dir that is not a temp dir", async (t) => {
    if (!existsSync(join(ROOT, "app", "node_modules", "ws", "index.js"))) {
      process.stdout.write("    (skipped: app/node_modules/ws is not installed)\n");
      return;
    }
    // a stand-in server that reports a real-looking data dir
    const stubPort = await freePort();
    const stub = http.createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, commit: "dev", date: "dev", dataDir: ROOT }));
    });
    await new Promise((ok) => stub.listen(stubPort, "127.0.0.1", ok));
    const child = spawn(process.execPath, [E2E, `http://127.0.0.1:${stubPort}`], {
      cwd: ROOT,
      env: { ...process.env, E2E_ALLOW_REAL_DATA: "" },
    });
    let err = "";
    child.stderr.on("data", (chunk) => {
      err += String(chunk);
    });
    const code = await new Promise((ok) => child.on("exit", (value) => ok(value)));
    stub.close();
    assert.equal(code, 2, `expected exit 2, got ${code}\n${err}`);
    assert.match(err, /refusing to run against DATA_DIR/);
  });
} finally {
  server.kill("SIGTERM");
  await new Promise((ok) => server.on("exit", ok));
  await rm(root, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const item of failures) console.log(`- ${item.name}: ${item.error?.message || item.error}`);
  process.exit(1);
}
