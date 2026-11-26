#!/usr/bin/env node
/**
 * scripts/install-watch-previews.mjs — start the preview watcher at login.
 *
 * Writes a per-user launchd agent (macOS) that runs scripts/watch-previews.mjs
 * in the background, so a board's PNG preview follows its edits without keeping
 * a terminal open. The watcher itself skips work when nothing changed, and its
 * pid file (`.cache/preview-watcher.pid`) keeps a manual run from doubling up.
 *
 * Usage
 *   node scripts/install-watch-previews.mjs              # install + start now
 *   node scripts/install-watch-previews.mjs --uninstall   # stop + remove
 *
 * The agent is `com.aixt.excalidraw.previews`; logs go to
 * `.cache/preview-watcher.log` in this checkout. Stop a manual run first, or the
 * agent's first start will see the pid file and stand down until it is free.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const LABEL = "com.aixt.excalidraw.previews";
const WATCHER = join(ROOT, "scripts", "watch-previews.mjs");
const LOG = join(ROOT, ".cache", "preview-watcher.log");
const PLIST_DIR = join(process.env.HOME || "", "Library", "LaunchAgents");
const PLIST = join(PLIST_DIR, `${LABEL}.plist`);
const DOMAIN = `gui/${process.getuid()}`;
const UNINSTALL = process.argv.includes("--uninstall");

const escapeXml = (value) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function launchctl(...args) {
  try {
    return execFileSync("launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    return String(error.stderr || error.message).trim();
  }
}

if (process.platform !== "darwin") {
  process.stderr.write("this installer uses launchd, so it only runs on macOS\n");
  process.exit(1);
}

if (UNINSTALL) {
  launchctl("bootout", `${DOMAIN}/${LABEL}`);
  rmSync(PLIST, { force: true });
  process.stdout.write(`removed ${PLIST}\n`);
  process.exit(0);
}

const nodePath = process.execPath;
const nodeDir = dirname(nodePath);
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(WATCHER)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(ROOT)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(`${nodeDir}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`)}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(LOG)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(LOG)}</string>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
</dict>
</plist>
`;

if (!existsSync(WATCHER)) {
  process.stderr.write(`missing ${WATCHER}\n`);
  process.exit(1);
}

mkdirSync(PLIST_DIR, { recursive: true });
mkdirSync(join(ROOT, ".cache"), { recursive: true });
writeFileSync(PLIST, plist);

// Replace a previous copy, then start it in this login session.
launchctl("bootout", `${DOMAIN}/${LABEL}`);
const loaded = launchctl("bootstrap", DOMAIN, PLIST);
if (loaded) {
  // `bootstrap` prints nothing on success; anything else is worth showing.
  process.stdout.write(`${loaded}\n`);
}
const started = launchctl("kickstart", "-k", `${DOMAIN}/${LABEL}`);
if (started) process.stdout.write(`${started}\n`);

const status = launchctl("print", `${DOMAIN}/${LABEL}`);
const running = /\bstate = running\b/.test(status) || /\bpid = \d+/.test(status);
process.stdout.write(`${running ? "✓" : "!"} ${LABEL} ${running ? "is running" : "did not start"}\n`);
process.stdout.write(`  plist: ${PLIST}\n  log:   ${LOG}\n`);
if (!running) process.exit(1);
