import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import TableBuilder from "./TableBuilder.jsx";
import GridOverlay from "./GridOverlay.jsx";
import { buildClass, describeClass, healClass, isClassGrid, toggleClass, updateClass } from "./class.js";
import RelationPanel from "./RelationPanel.jsx";
import RelationWaypoints from "./RelationWaypoints.jsx";
import TableHoverArrows from "./TableHoverArrows.jsx";
import Minimap from "./Minimap.jsx";
import LassoTool from "./tools/LassoTool.jsx";
import {
  attachCellText,
  buildGrid,
  healGrid,
  gridMetrics,
  isGridCell,
  matchSizes,
  resizeGridColumn,
  resizeGridRow,
} from "./table.js";
import { applyCardinalityToElements, cloneAndConnect, describeRelation, syncRelations } from "./relations.js";

const SAVE_DELAY = 900; // http fallback (no websocket)
const LIVE_DELAY = 300; // websocket push while several people edit
const ARM_DELAY = 1200; // ignore the onChange burst that follows the initial load
const SAVE_APP_STATE = ["viewBackgroundColor", "gridSize", "gridStep", "gridModeEnabled", "theme"];

/* Inline icons: the board chrome needs only a back arrow, a tools glyph and the
   table button, not an icon dependency. */
const icon = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": "true",
  focusable: "false",
};

const IconBack = () => (
  <svg {...icon}>
    <path d="M15 5l-7 7 7 7" />
  </svg>
);
const IconTools = () => (
  <svg {...icon} width={15} height={15}>
    <path d="M4 20v-5M12 20V9M20 20v-8" />
    <path d="M2 12h4M10 6h4M18 17h4" />
  </svg>
);
/* The table button lives in the drawing tools row, so it borrows their metrics. */
const IconTable = () => (
  <svg {...icon} width={17} height={17} strokeWidth={1.6}>
    <rect x="2.4" y="3.4" width="12.6" height="12.2" rx="2.1" />
    <path d="M2.4 7.3h12.6M6.6 7.3v8.3M10.8 7.3v8.3" />
    <path d="M19.6 15.6v5.6M16.8 18.4h5.6" strokeWidth={2.1} />
  </svg>
);

/* Theme toggle: a moon while light, a sun while dark. */
const IconMoon = () => (
  <svg {...icon} width={17} height={17} strokeWidth={1.6}>
    <path d="M20.2 14.8A8.2 8.2 0 1 1 9.6 3.8a6.6 6.6 0 0 0 10.6 11z" />
  </svg>
);
const IconSun = () => (
  <svg {...icon} width={17} height={17} strokeWidth={1.6}>
    <circle cx="12" cy="12" r="4.1" />
    <path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6" />
  </svg>
);

/* Same metrics as the table button: a map frame with the viewport inside. */
const IconMinimap = () => (
  <svg {...icon} width={17} height={17} strokeWidth={1.6}>
    <rect x="2.4" y="3.6" width="14.4" height="12.8" rx="2.1" />
    <path d="M2.4 9.2h5.1v7.2M12.2 3.6v5.4h4.6" />
    <rect x="12.6" y="11.4" width="5.4" height="4.4" rx="1" strokeWidth={1.4} />
  </svg>
);

/* "แขก 42" has to render as one Thai cluster, not a dotted-circle vowel: a
   leading vowel (เ แ โ ใ ไ) is its own grapheme cluster, so glue it to the
   consonant that follows. */
const THAI_LEADING_VOWEL = /^[\u0E40-\u0E44]$/;

function avatarInitial(name) {
  const text = String(name || "").trim();
  if (!text) return "?";
  try {
    const clusters = [...new Intl.Segmenter("th", { granularity: "grapheme" }).segment(text)].map(
      (part) => part.segment,
    );
    const first = clusters[0] || "?";
    const glyph =
      THAI_LEADING_VOWEL.test(first) && clusters[1] ? `${first}${clusters[1]}` : first;
    return glyph.toUpperCase();
  } catch {
    return text.slice(0, 1).toUpperCase();
  }
}

/* White lettering disappears on the sand/yellow peer colours. */
function avatarInk(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
  if (!match) return "#ffffff";
  const n = Number.parseInt(match[1], 16);
  const luma = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  return luma > 168 ? "#23232b" : "#ffffff";
}

/**
 * The parts of a scene that a reader would call "the same picture".
 * Excalidraw bumps `version`/`versionNonce`/`updated` on elements whenever it
 * rewrites them — including when it merely applies what a peer sent — so two
 * boards can look identical yet keep writing each other's bytes forever.
 */
const VOLATILE_KEYS = ["version", "versionNonce", "updated"];
let stableCache = { body: "", stable: "" };
function stableOf(body) {
  if (!body) return "";
  if (stableCache.body === body) return stableCache.stable;
  let stable = body;
  try {
    const scene = JSON.parse(body);
    scene.elements = (scene.elements || []).map((el) => {
      const copy = { ...el };
      for (const key of VOLATILE_KEYS) delete copy[key];
      return copy;
    });
    stable = JSON.stringify(scene);
  } catch {
    stable = body;
  }
  stableCache = { body, stable };
  return stable;
}

function payloadFor(elements, appState, files) {
  const picked = {};
  for (const key of SAVE_APP_STATE) {
    if (appState && appState[key] !== undefined) picked[key] = appState[key];
  }
  return JSON.stringify({
    type: "excalidraw",
    version: 2,
    source: "boards-server",
    elements,
    appState: picked,
    files: files || {},
  });
}

/**
 * Is `a` a newer revision of the same element than `b`?
 * Excalidraw bumps `version` on every edit and `versionNonce` breaks ties.
 */
function fresher(a, b) {
  const av = a?.version ?? 0;
  const bv = b?.version ?? 0;
  if (av !== bv) return av > bv;
  return ((a?.versionNonce ?? 0) >>> 0) > ((b?.versionNonce ?? 0) >>> 0);
}

/**
 * Merge two versions of the same board, element by element, so simultaneous
 * edits do not cancel each other out. Returns the merged list plus whether the
 * incoming scene actually changed anything.
 *
 * The local order is kept as the drawing order: reordering on every remote
 * update made both sides look different from each other and they would bounce
 * the same scene back and forth forever.
 */
function mergeElements(local, remote) {
  const byId = new Map(local.map((el) => [el.id, el]));
  const remoteIds = new Set(remote.map((el) => el.id));
  let changed = false;

  for (const el of remote) {
    const mine = byId.get(el.id);
    if (!mine || fresher(el, mine)) {
      byId.set(el.id, el);
      changed = true;
    }
  }

  // do we hold anything the sender does not? then our copy has to be published,
  // otherwise the next reload loses it
  const extra = local.some((el) => !remoteIds.has(el.id));
  if (!changed) return { elements: local, changed: false, extra };

  const merged = local.map((el) => byId.get(el.id));
  const placed = new Set(merged.map((el) => el.id));
  for (const el of remote) {
    if (!placed.has(el.id)) merged.push(byId.get(el.id));
  }
  return { elements: merged, changed: true, extra };
}

function readBoardId() {
  const match = window.location.pathname.match(/^\/b\/([^/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function guestName() {
  try {
    const saved = window.localStorage.getItem("boards-name");
    if (saved) return saved;
    const name = `แขก ${Math.floor(10 + Math.random() * 90)}`;
    window.localStorage.setItem("boards-name", name);
    return name;
  } catch {
    return "แขก";
  }
}

const TAB_SID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * One id per tab, kept in sessionStorage: it survives a reload (so the server
 * can replace this tab's previous socket instead of counting a phantom guest)
 * and still differs between two tabs of the same board.
 */
function tabSid() {
  try {
    const saved = window.sessionStorage.getItem("boards-tab-sid");
    if (saved && TAB_SID_RE.test(saved)) return saved;
    const uuid = window.crypto?.randomUUID?.() || `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
    const sid = uuid.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
    window.sessionStorage.setItem("boards-tab-sid", sid);
    return sid;
  } catch {
    return `t${Math.random().toString(36).slice(2, 12)}`;
  }
}

/* The drawing tools float above the canvas: drag the little grip to move them
   anywhere, and fold them away when the canvas needs the room. */
const TOOLS_KEY = "boards-tools";
const MINIMAP_KEY = "boards-minimap";
const MINIMAP_FOLD_KEY = "boards-minimap-fold";
const THEME_KEY = "boards-theme";
const TOOLS_MARGIN = 8;

/* Below this width Excalidraw swaps in its own mobile row and our extra controls
   step aside; the same breakpoint as the stylesheet. */
const isPhone = () => window.matchMedia("(max-width: 560px)").matches;

function readToolsPrefs() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(TOOLS_KEY) || "null");
    return {
      x: Number.isFinite(saved?.x) ? saved.x : null,
      y: Number.isFinite(saved?.y) ? saved.y : null,
      collapsed: saved?.collapsed === true,
    };
  } catch {
    return { x: null, y: null, collapsed: false };
  }
}

export default function App() {
  const boardId = useRef(readBoardId()).current;

  const [phase, setPhase] = useState("loading"); // loading | ready | error
  const [scene, setScene] = useState(null);
  const [fatal, setFatal] = useState(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [selectedGrid, setSelectedGrid] = useState(null);
  const [selectedClass, setSelectedClass] = useState(null);
  const [selectedRelation, setSelectedRelation] = useState(null);
  const [activeCell, setActiveCell] = useState(null);
  const [peers, setPeers] = useState([]);
  const [live, setLive] = useState("connecting"); // connecting | open | closed
  const [title, setTitle] = useState(boardId || "");
  const [theme, setTheme] = useState(() => {
    try {
      return window.localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
    } catch {
      return "light";
    }
  });
  // the board's saved theme wins, but a board that never stored one opens in
  // whatever this browser used last
  const themePrefRef = useRef(theme);
  const toolsPrefsRef = useRef(null);
  if (!toolsPrefsRef.current) toolsPrefsRef.current = readToolsPrefs();
  const [toolsPos, setToolsPos] = useState(() => {
    const saved = toolsPrefsRef.current;
    return saved.x === null || saved.y === null ? null : { x: saved.x, y: saved.y };
  });
  const [toolsCollapsed, setToolsCollapsed] = useState(toolsPrefsRef.current.collapsed);
  const [toolsReady, setToolsReady] = useState(false);
  const [toolsEpoch, setToolsEpoch] = useState(0);
  // DOM slot inside the drawing tools row; the table button is portalled into it.
  const [tableSlot, setTableSlot] = useState(null);
  // the minimap is on unless someone turned it off; the choice survives a reload
  const [minimapOn, setMinimapOn] = useState(() => {
    try {
      return window.localStorage.getItem(MINIMAP_KEY) !== "off";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(MINIMAP_KEY, minimapOn ? "on" : "off");
    } catch {
      /* private mode: the toggle still works for this session */
    }
  }, [minimapOn]);
  /* The card folds down to a pill the way the drawing tools do, so it can get
     out of the way without losing the board's place. */
  const [minimapFolded, setMinimapFolded] = useState(() => {
    try {
      return window.localStorage.getItem(MINIMAP_FOLD_KEY) === "on";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(MINIMAP_FOLD_KEY, minimapFolded ? "on" : "off");
    } catch {
      /* private mode: folding still works for this session */
    }
  }, [minimapFolded]);
  // DOM slot inside Excalidraw's top-right menu row (next to Library), when that
  // row exists. Phones have no such row, so the stack falls back to the corner.
  const [presenceHost, setPresenceHost] = useState(null);
  // "saved" | "saving" | "error": the pill in the top-right corner tells the board's save state
  const [saveState, setSaveState] = useState({ kind: "saved", at: 0 });
  // the html element carries the theme so the page chrome and the canvas agree
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    try {
      window.localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* private mode: the toggle still works for this session */
    }
  }, [theme]);

  const apiRef = useRef(null);
  const wsRef = useRef(null);
  const sidRef = useRef("");
  if (!sidRef.current) sidRef.current = tabSid();
  const meRef = useRef(null);
  const pendingRef = useRef(null);
  const lastSavedRef = useRef(null);
  const lastSentRef = useRef(null);
  const timerRef = useRef(0);
  const armedAtRef = useRef(0);
  const armReplayRef = useRef(null); // an edit that arrived before the board was armed
  const armTimerRef = useRef(0);
  const onChangeRef = useRef(null);
  const remoteRef = useRef(null);
  const remoteTimerRef = useRef(0);
  const goneRef = useRef(false);
  const presenceRef = useRef(null);
  const canvasRef = useRef(null);
  const resizeDragRef = useRef(null); // scene as it was before the current slider drag
  const resizeFrameRef = useRef(0);
  const sceneEpochRef = useRef(0); // bumped whenever something other than a drag edits a table

  /** Drop any half-finished slider drag: its base scene may already be outdated. */
  const forgetResizeDrag = useCallback(() => {
    sceneEpochRef.current += 1;
    resizeDragRef.current = null;
    if (resizeFrameRef.current) {
      cancelAnimationFrame(resizeFrameRef.current);
      resizeFrameRef.current = 0;
    }
  }, []);
  const toolsRef = useRef(null);
  const toolsNaturalRef = useRef(null);
  const toolsDragRef = useRef(null);
  const launcherRef = useRef(null);
  const launcherDragRef = useRef(null);
  const launcherMovedRef = useRef(false);
  const toolsCollapsedRef = useRef(toolsCollapsed);
  toolsCollapsedRef.current = toolsCollapsed;

  /* ---------------------------------------------------------------- boot */

  useEffect(() => {
    let alive = true;

    (async () => {
      if (window.location.pathname === "/new") {
        const res = await fetch("/api/boards", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        if (!res.ok) throw new Error(`สร้างกระดานไม่สำเร็จ (${res.status})`);
        const created = await res.json();
        window.location.replace(`/b/${encodeURIComponent(created.id)}`);
        return;
      }

      if (!boardId) throw new Error("ไม่มีรหัสกระดานใน URL");

      // scene + sidecar together; a missing/broken sidecar must never block the
      // editor, so the meta request resolves to null instead of rejecting
      const encoded = encodeURIComponent(boardId);
      const [res, metaRes] = await Promise.all([
        fetch(`/api/boards/${encoded}`),
        fetch(`/api/boards/${encoded}/meta`).catch(() => null),
      ]);
      if (!res.ok) throw new Error(`โหลดกระดาน ${boardId} ไม่ได้ (${res.status})`);
      const data = await res.json();
      const meta = metaRes && metaRes.ok ? await metaRes.json().catch(() => null) : null;
      if (!alive) return;
      const loadedTitle = typeof meta?.title === "string" && meta.title.trim() ? meta.title : boardId;
      armedAtRef.current = Date.now() + ARM_DELAY;
      lastSavedRef.current = payloadFor(data.elements || [], data.appState || {}, data.files || {});
      setSaveState({ kind: "saved", at: Date.now() });
      setTitle(loadedTitle);
      // a board that stored a theme keeps it; one that never did follows the
      // last choice made in this browser
      const storedTheme = data.appState && data.appState.theme;
      setTheme(
        storedTheme === "dark" || storedTheme === "light" ? storedTheme : themePrefRef.current,
      );
      setScene(data);
      setPhase("ready");
    })().catch((error) => {
      if (!alive) return;
      document.title = "ไม่พบกระดาน · Excalidraw boards";
      setFatal(error?.message || String(error));
      setPhase("error");
    });

    return () => {
      alive = false;
    };
  }, [boardId]);

  // the tab title follows the board name (and any rename from another viewer)
  useEffect(() => {
    if (phase === "ready") document.title = `${title} · Excalidraw boards`;
  }, [phase, title]);

  /* ------------------------------------------------------ floating draw tools */

  const clampTools = useCallback(() => {
    const el = toolsRef.current;
    if (!el || toolsCollapsedRef.current) return;
    const rect = el.getBoundingClientRect();
    if (!rect.width && !rect.height) return;
    const viewW = document.documentElement.clientWidth || window.innerWidth;
    const viewH = document.documentElement.clientHeight || window.innerHeight;
    setToolsPos((pos) => {
      if (!pos) return pos;
      const maxX = Math.max(TOOLS_MARGIN, viewW - rect.width - TOOLS_MARGIN);
      const maxY = Math.max(TOOLS_MARGIN, viewH - rect.height - TOOLS_MARGIN);
      const x = Math.min(Math.max(TOOLS_MARGIN, pos.x), maxX);
      const y = Math.min(Math.max(TOOLS_MARGIN, pos.y), maxY);
      return x === pos.x && y === pos.y ? pos : { x, y };
    });
  }, []);

  const resetToolsPosition = useCallback(() => {
    // When the row is folded away the toolbar is display:none and measures 0,
    // so the pill is the element that has to go back to the middle.
    const el = toolsCollapsedRef.current ? launcherRef.current : toolsRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const viewW = document.documentElement.clientWidth || window.innerWidth;
    setToolsPos({
      x: Math.max(TOOLS_MARGIN, Math.round((viewW - rect.width) / 2)),
      y: Math.max(TOOLS_MARGIN, toolsNaturalRef.current?.y ?? 65),
    });
  }, []);

  // Excalidraw owns the drawing-tool island. Give its row a grip and a fold
  // button, then treat the island as our own floating panel (fixed coordinates
  // so it can travel over the canvas and stay put when the canvas scrolls).
  /* Phones keep Excalidraw's own mobile tool row: it is already sized for the
     small island, and floating it would push the row past the screen edge. */

  // Excalidraw mounts its toolbar a frame or two after the board becomes ready,
  // and re-renders it as a fresh node now and then. Poll for a while instead of
  // looking once: bump the epoch whenever the row is there but our grip is not,
  // so both the first mount and a later replacement get the grip, the table slot
  // and the fold control.
  useEffect(() => {
    if (phase !== "ready") return undefined;
    let cancelled = false;
    let timer = 0;
    const startedAt = performance.now();
    const look = () => {
      if (cancelled) return;
      if (!isPhone()) {
        const row = canvasRef.current?.querySelector(".App-toolbar");
        const stack = row?.querySelector(".Stack.Stack_horizontal");
        if (stack && !row.querySelector(".tools-grip")) setToolsEpoch((value) => value + 1);
      }
      if (performance.now() - startedAt < 20000) timer = window.setTimeout(look, 200);
    };
    look();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [phase]);

  useEffect(() => {
    if (phase !== "ready" || isPhone()) return undefined;
    const el = canvasRef.current?.querySelector(".App-toolbar");
    if (!el) return undefined;
    const stack = el.querySelector(":scope > .Stack.Stack_horizontal") || el.querySelector(".Stack.Stack_horizontal");
    if (!stack) return undefined;
    toolsRef.current = el;
    const natural = el.getBoundingClientRect();
    toolsNaturalRef.current = { x: natural.left, y: natural.top };
    const saved = toolsPrefsRef.current;
    const start = {
      x: Number.isFinite(saved.x) ? saved.x : natural.left,
      y: Number.isFinite(saved.y) ? saved.y : natural.top,
    };
    el.style.left = `${start.x}px`;
    el.style.top = `${start.y}px`;
    el.classList.add("tools-floating");
    setToolsPos((pos) => pos || start);
    setToolsReady(true);

    const grip = document.createElement("button");
    grip.type = "button";
    grip.className = "tools-grip";
    grip.title = "ลากเพื่อย้ายเครื่องมือวาด · ดับเบิลคลิกเพื่อวางกลับตรงกลาง";
    grip.setAttribute("aria-label", "ลากเครื่องมือวาด");
    grip.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>';

    const fold = document.createElement("button");
    fold.type = "button";
    fold.className = "tools-fold";
    fold.title = "ย่อเครื่องมือวาด";
    fold.setAttribute("aria-label", "ย่อเครื่องมือวาด");
    fold.innerHTML =
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14"/></svg>';

    // The table button is a React portal, not DOM surgery: this span only marks
    // where in the row it belongs (just before the fold control).
    const slot = document.createElement("span");
    slot.className = "tools-table-slot";

    stack.prepend(grip);
    stack.append(slot);
    stack.append(fold);
    setTableSlot(slot);

    const clampPoint = (x, y) => {
      const rect = el.getBoundingClientRect();
      const viewW = document.documentElement.clientWidth || window.innerWidth;
      const viewH = document.documentElement.clientHeight || window.innerHeight;
      return {
        x: Math.min(Math.max(TOOLS_MARGIN, x), Math.max(TOOLS_MARGIN, viewW - rect.width - TOOLS_MARGIN)),
        y: Math.min(Math.max(TOOLS_MARGIN, y), Math.max(TOOLS_MARGIN, viewH - rect.height - TOOLS_MARGIN)),
      };
    };

    // The avatar pill shares this band on the right. On narrower screens the
    // centred tools row would slide under it, so nudge the row clear once the
    // pill exists (and again on resize) unless someone dragged it.
    const keepClear = () => {
      if (toolsDragRef.current) return;
      const pill = document.querySelector(".presence");
      if (!pill) return;
      const rect = el.getBoundingClientRect();
      const limit = pill.getBoundingClientRect().left - TOOLS_MARGIN;
      if (rect.right <= limit) return;
      const next = clampPoint(limit - rect.width, rect.top);
      el.style.left = `${next.x}px`;
      setToolsPos(next);
    };
    const clearTimer = window.setTimeout(keepClear, 800);
    window.addEventListener("resize", keepClear);

    // Pointer capture is a nicety, not the mechanism: Safari can refuse it on a
    // strip inside a transformed stacking context, and any drag that left the
    // 17px grip would die mid-way. Window listeners keep it alive everywhere.
    const onMove = (event) => {
      const drag = toolsDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      event.preventDefault();
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      setToolsPos(clampPoint(drag.originX + dx, drag.originY + dy));
    };
    const onUp = () => {
      if (!toolsDragRef.current) return;
      toolsDragRef.current = null;
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
    };
    const beginDrag = (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = el.getBoundingClientRect();
      toolsDragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: rect.left,
        originY: rect.top,
      };
      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("pointerup", onUp, true);
      window.addEventListener("pointercancel", onUp, true);
      try {
        grip.setPointerCapture(event.pointerId);
      } catch {
        /* the window listeners are what actually move it */
      }
    };
    const onDown = (event) => beginDrag(event);
    // Any blank part of the island drags it too, so nobody has to find the grip;
    // the tools themselves keep their own clicks.
    const onSurfaceDown = (event) => {
      if (event.target.closest?.("button, label, input, select, textarea, a[href], .ToolIcon")) return;
      beginDrag(event);
    };
    const onFold = (event) => {
      event.preventDefault();
      event.stopPropagation();
      setToolsCollapsed(true);
    };
    grip.addEventListener("pointerdown", onDown);
    grip.addEventListener("dblclick", resetToolsPosition);
    el.addEventListener("pointerdown", onSurfaceDown);
    fold.addEventListener("click", onFold);

    // React re-renders the tool row on theme/tool changes; keep our controls,
    // grip first and fold last, with the table slot in front of the fold.
    const keepControls = () => {
      if (stack.firstElementChild !== grip) stack.prepend(grip);
      if (!stack.contains(slot)) stack.insertBefore(slot, fold.isConnected ? fold : null);
      if (stack.lastElementChild !== fold) stack.append(fold);
    };
    const observer = new MutationObserver(keepControls);
    observer.observe(stack, { childList: true });

    return () => {
      observer.disconnect();
      window.clearTimeout(clearTimer);
      window.removeEventListener("resize", keepClear);
      grip.removeEventListener("pointerdown", onDown);
      grip.removeEventListener("dblclick", resetToolsPosition);
      el.removeEventListener("pointerdown", onSurfaceDown);
      onUp();
      fold.removeEventListener("click", onFold);
      grip.remove();
      slot.remove();
      fold.remove();
      setTableSlot(null);
      el.classList.remove("tools-floating");
      el.style.left = "";
      el.style.top = "";
      toolsDragRef.current = null;
      setToolsReady(false);
      if (toolsRef.current === el) toolsRef.current = null;
    };
  }, [phase, resetToolsPosition, toolsEpoch]);

  /* Crossing the phone line swaps in Excalidraw's mobile row, so the float effect
     has to run again (float on desktop, clean up on phones). */
  useEffect(() => {
    if (phase !== "ready") return undefined;
    const query = window.matchMedia("(max-width: 560px)");
    const onChange = () => setToolsEpoch((epoch) => epoch + 1);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [phase]);

  /* The avatar stack lives in Excalidraw's own top-right menu row, immediately
     left of the Library button. That row is unmounted on phones, so the stack
     falls back to the pinned corner pill there. */
  useEffect(() => {
    if (phase !== "ready") return undefined;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    let host = null;
    let queued = false;

    const attach = () => {
      if (isPhone()) {
        // the desktop row scrolls out of the phone viewport, so the stack goes
        // back to the pinned corner instead of docking
        if (host) {
          host.remove();
          host = null;
        }
        setPresenceHost(null);
        return;
      }
      const row = canvas.querySelector(".layer-ui__wrapper__top-right");
      if (!row) {
        if (host) {
          host = null;
          setPresenceHost(null);
        }
        return;
      }
      if (!host || !host.isConnected) {
        host = document.createElement("span");
        host.className = "presence-slot";
        row.insertBefore(host, row.firstChild);
        setPresenceHost(host);
      } else if (row.firstElementChild !== host) {
        // keep the stack immediately left of the Library button, whatever
        // order Excalidraw re-renders its own row in
        row.insertBefore(host, row.firstElementChild);
      }
    };

    const schedule = () => {
      if (queued) return;
      queued = true;
      window.requestAnimationFrame(() => {
        queued = false;
        attach();
      });
    };

    attach();
    // the menu is rebuilt on tool/theme/zen changes, and it disappears entirely
    // when the viewport turns into a phone one
    const observer = new MutationObserver(schedule);
    observer.observe(canvas, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      if (host) host.remove();
      setPresenceHost(null);
    };
  }, [phase, toolsEpoch]);

  useEffect(() => {
    const el = toolsRef.current;
    if (!el || !toolsPos) return;
    el.style.left = `${toolsPos.x}px`;
    el.style.top = `${toolsPos.y}px`;
  }, [toolsPos]);

  useEffect(() => {
    if (phase !== "ready" || !toolsReady || toolsCollapsed) return;
    clampTools();
  }, [phase, toolsReady, toolsCollapsed, toolsPos, clampTools]);

  // The folded pill is the toolbar's only visible part, so it has to travel the
  // same way: drag to move, plain click still opens the row, double-click resets.
  useEffect(() => {
    const pill = launcherRef.current;
    if (!pill || !toolsCollapsed) return undefined;

    const clampPill = (x, y) => {
      const rect = pill.getBoundingClientRect();
      const viewW = document.documentElement.clientWidth || window.innerWidth;
      const viewH = document.documentElement.clientHeight || window.innerHeight;
      return {
        x: Math.min(Math.max(TOOLS_MARGIN, x), Math.max(TOOLS_MARGIN, viewW - rect.width - TOOLS_MARGIN)),
        y: Math.min(Math.max(TOOLS_MARGIN, y), Math.max(TOOLS_MARGIN, viewH - rect.height - TOOLS_MARGIN)),
      };
    };

    const onMove = (event) => {
      const drag = launcherDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      event.preventDefault();
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) launcherMovedRef.current = true;
      setToolsPos(clampPill(drag.originX + dx, drag.originY + dy));
    };
    const onUp = () => {
      if (!launcherDragRef.current) return;
      launcherDragRef.current = null;
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
    };
    const onDown = (event) => {
      if (event.button !== 0) return;
      const rect = pill.getBoundingClientRect();
      launcherDragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: rect.left,
        originY: rect.top,
      };
      launcherMovedRef.current = false;
      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("pointerup", onUp, true);
      window.addEventListener("pointercancel", onUp, true);
    };
    pill.addEventListener("pointerdown", onDown);
    return () => {
      pill.removeEventListener("pointerdown", onDown);
      onUp();
    };
    // Deliberately not keyed on toolsPos: the drag itself moves the pill, and
    // re-running this effect on every move would tear the listeners down after
    // the first pixel. No double-click reset either — a single click opens the
    // row, so the pill cannot also wait for a second one.
  }, [toolsCollapsed, resetToolsPosition]);

  useEffect(() => {
    const onResize = () => clampTools();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clampTools]);

  useEffect(() => {
    if (!toolsPos) return undefined;
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(
          TOOLS_KEY,
          JSON.stringify({ ...toolsPos, collapsed: toolsCollapsed }),
        );
      } catch {
        /* private mode: remembering the spot is optional */
      }
    }, 200);
    return () => window.clearTimeout(timer);
  }, [toolsPos, toolsCollapsed]);

  /* ---------------------------------------------------------------- saving */

  const saveOverHttp = useCallback(async () => {
    const body = pendingRef.current;
    if (!body || !boardId || goneRef.current) return;
    try {
      const res = await fetch(`/api/boards/${encodeURIComponent(boardId)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body,
      });
      if (!res.ok) throw new Error(await res.text());
      lastSavedRef.current = body;
      if (pendingRef.current === body) pendingRef.current = null;
      setSaveState({ kind: "saved", at: Date.now() });
    } catch (error) {
      console.error("[save]", error);
      setSaveState({ kind: "error", at: Date.now() });
    }
  }, [boardId]);

  const flush = useCallback(() => {
    const ws = wsRef.current;
    const body = pendingRef.current;
    if (!body || goneRef.current) return;
    if (ws && ws.readyState === 1) {
      lastSentRef.current = body;
      ws.send(JSON.stringify({ type: "update", scene: JSON.parse(body) }));
      return;
    }
    void saveOverHttp();
  }, [saveOverHttp]);

  /** Queue a change: websocket first, plain HTTP when the socket is down. */
  const queueSave = useCallback(
    (elements, appState, files) => {
      if (!boardId || goneRef.current) return;
      const body = payloadFor(elements, appState, files);
      // Excalidraw fires onChange for cursor and selection movement too; without
      // this an identical body would re-arm the debounce forever and the save
      // would never actually happen.
      if (body === pendingRef.current) return;
      if (body === lastSavedRef.current || body === lastSentRef.current) {
        if (body === lastSavedRef.current) {
          pendingRef.current = null;
          // an undone edit can land back on exactly what is on disk
          setSaveState((state) => (state.kind === "saving" ? { kind: "saved", at: state.at || Date.now() } : state));
        }
        return;
      }
      // Same picture, only books bumped: writing it would push the peer to bump
      // theirs and the two boards would trade the file forever.
      if (lastSavedRef.current && stableOf(body) === stableOf(lastSavedRef.current)) {
        pendingRef.current = null;
        lastSavedRef.current = body;
        setSaveState((state) => (state.kind === "saved" ? state : { kind: "saved", at: state.at || Date.now() }));
        return;
      }
      pendingRef.current = body;
      setSaveState((state) => (state.kind === "saving" ? state : { kind: "saving", at: state.at }));
      window.clearTimeout(timerRef.current);
      const ws = wsRef.current;
      // a hidden tab has its timers throttled to about one tick a second, so a
      // change made there would sit unsaved; write it out right away instead
      if (document.visibilityState === "hidden") {
        flush();
        return;
      }
      timerRef.current = window.setTimeout(flush, ws && ws.readyState === 1 ? LIVE_DELAY : SAVE_DELAY);
    },
    [boardId, flush],
  );

  /* The board remembers the theme it was last saved in, so a flip has to reach
     the scene; the localStorage copy only decides which page opens first. */
  const toggleTheme = useCallback(() => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    const api = apiRef.current;
    if (!api || goneRef.current) return;
    queueSave(api.getSceneElements(), { ...api.getAppState(), theme: next }, api.getFiles());
  }, [theme, queueSave]);

  /** A failed save leaves the pill clickable: send the current scene again. */
  // Nothing can be in flight here, so a pill stuck on "saving" would be wrong:
  // that happens when a dropped queue entry takes its timer with it.
  useEffect(() => {
    if (saveState.kind !== "saving") return undefined;
    const timer = window.setTimeout(() => {
      if (!pendingRef.current && !lastSentRef.current) {
        setSaveState((state) => (state.kind === "saving" ? { kind: "saved", at: state.at || Date.now() } : state));
      }
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [saveState.kind, saveState.at]);

  const retrySave = useCallback(() => {
    if (saveState.kind === "saving") return;
    const api = apiRef.current;
    if (!api || goneRef.current) return;
    lastSentRef.current = null;
    pendingRef.current = null;
    queueSave(api.getSceneElements(), api.getAppState(), api.getFiles());
  }, [queueSave, saveState.kind]);

  /** Everything the table panel needs to know about one grid. */
  const describeGrid = useCallback((elements, gridId) => {
    const rects = elements.filter((el) => isGridCell(el, gridId));
    if (!rects.length) return null;
    const metrics = gridMetrics(elements, gridId);
    const first = rects[0].customData;
    const rows = Math.max(...rects.map((x) => x.customData?.r ?? 0)) + 1;
    const cols = Math.max(...rects.map((x) => x.customData?.c ?? 0)) + 1;
    const head = elements.find((el) => !el.isDeleted && el.type === "text" && el.customData?.grid === gridId && el.customData?.title);
    return {
      kind: "grid",
      grid: gridId,
      rows,
      cols,
      color: first.color,
      headerRow: first.headerRow,
      // the panel edits the heading in place, so it has to know the current one
      title: head?.text ?? "",
      width: metrics ? Math.round(metrics.bounds.width) : 0,
      height: metrics ? Math.round(metrics.bounds.height) : 0,
      rowHeights: metrics ? metrics.rows.map((row) => Math.round(row.height)) : [],
      colWidths: metrics ? metrics.cols.map((col) => Math.round(col.width)) : [],
    };
  }, []);

  const sameGridInfo = (a, b) =>
    !!a &&
    !!b &&
    a.title === b.title &&
    a.grid === b.grid &&
    a.rows === b.rows &&
    a.cols === b.cols &&
    a.width === b.width &&
    a.height === b.height &&
    a.color === b.color &&
    a.headerRow === b.headerRow &&
    a.rowHeights.join() === b.rowHeights.join() &&
    a.colWidths.join() === b.colWidths.join();

  const sameClassInfo = (a, b) =>
    !!a &&
    !!b &&
    a.grid === b.grid &&
    a.title === b.title &&
    a.width === b.width &&
    a.collapsed === b.collapsed &&
    a.fields.join("\n") === b.fields.join("\n") &&
    a.methods.join("\n") === b.methods.join("\n");

  /* A relation panel only needs to re-render when it moves to another arrow or
     the cardinality changes; selection noise around it must not rebuild it. */
  const sameRelation = (a, b) => {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return a.arrowId === b.arrowId && a.fromGrid === b.fromGrid && a.toGrid === b.toGrid && a.preset === b.preset;
  };

  const onChange = useCallback(
    (elements, appState, files) => {
      // Which table is selected has to follow the scene from the first click, even
      // during the load burst: dropping those events left the panel saying "no
      // table" for a cell the person had just clicked. Only saving waits.
      let hit = null;
      let classHit = null;
      const selectedIds = appState?.selectedElementIds || {};
      for (const el of elements) {
        if (selectedIds[el.id] && el.customData?.grid) {
          const gridId = el.customData.grid;
          if (isClassGrid(elements, gridId)) {
            classHit = describeClass(elements, gridId);
          } else {
            hit = describeGrid(elements, gridId);
          }
          break;
        }
      }
      setSelectedGrid((prev) => (sameGridInfo(prev, hit) ? prev : hit));
      setSelectedClass((prev) => (sameClassInfo(prev, classHit) ? prev : classHit));

      // The relation panel edits one arrow at a time: show it only while exactly
      // one relation arrow is selected, so a box-select never opens it.
      const pickedArrows = elements.filter(
        (el) => selectedIds[el.id] && el.type === "arrow" && el.customData?.relation && !el.isDeleted,
      );
      const relation = pickedArrows.length === 1 ? describeRelation(pickedArrows[0]) : null;
      setSelectedRelation((prev) => (sameRelation(prev, relation) ? prev : relation));

      if (Date.now() < armedAtRef.current) {
        // The burst that follows a load is Excalidraw restoring what the file
        // already holds: identical body, nothing to write, and the pill must not
        // pretend otherwise.
        const early = payloadFor(elements, appState, files);
        if (early === lastSavedRef.current || early === lastSentRef.current) return;
        // An edit can also land before the board is armed. Dropping it left the
        // canvas changed while the pill said "saved"; keep the newest and replay
        // it once arming is done.
        armReplayRef.current = { elements, appState, files };
        window.clearTimeout(armTimerRef.current);
        armTimerRef.current = window.setTimeout(() => {
          const replay = armReplayRef.current;
          armReplayRef.current = null;
          if (replay && !goneRef.current) onChangeRef.current?.(replay.elements, replay.appState, replay.files);
        }, Math.max(30, armedAtRef.current - Date.now() + 40));
        setSaveState((state) => (state.kind === "saving" ? state : { kind: "saving", at: state.at }));
        return;
      }

      // Text typed into a cell arrives at whatever size the editor used, and
      // Excalidraw grows the container it is bound to when the text does not fit,
      // so one edit can inflate a single cell and warp its row. Put the tiling
      // back and shrink the text into it once the edit is committed; the second
      // pass finds nothing to do, so this settles instead of looping.
      const api = apiRef.current;
      const scene = api?.getSceneElementsIncludingDeleted?.() ?? elements;
      // Excalidraw 0.18 keys: group drags set selectedElementsAreBeingDragged,
      // not a `draggingElement` field. The heal pass must stay out of every
      // live gesture, otherwise syncRelations and Excalidraw's own bound-arrow
      // update fight each other and the connector flickers while a table moves.
      const busy =
        appState?.selectedElementsAreBeingDragged ||
        appState?.resizingElement ||
        appState?.selectionElement ||
        appState?.newElement ||
        appState?.editingTextElement ||
        appState?.editingLinearElement;
      if (!busy) {
        const grids = new Set(
          scene.filter((el) => el.customData?.grid && !el.isDeleted).map((el) => el.customData.grid),
        );
        let healed = scene;
        let touched = false;
        for (const gridId of grids) {
          const next = isClassGrid(healed, gridId)
            ? healClass(healed, gridId)
            : healGrid(healed, gridId);
          if (next) {
            healed = next;
            touched = true;
          }
        }
        // frames, bindings and endpoints follow the tables after any move,
        // resize, rebuild or undo; a repair like the grid heal above
        const synced = syncRelations(healed);
        if (synced) {
          healed = synced;
          touched = true;
        }
        if (touched) {
          window.requestAnimationFrame(() => {
            // a repair, not user intent: keep it out of the undo history so a
            // later Cmd+Z still steps over the edit that needed repairing
            if (apiRef.current === api) api.updateScene({ elements: healed, captureUpdate: "NEVER" });
          });
          return;
        }
      }

      queueSave(elements, appState, files);
    },
    [describeGrid, queueSave],
  );

  // the arming timer outlives the render that scheduled it, so it calls through a ref
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // flush on hide (covers tab close / switching away far more reliably than unload)
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") {
        window.clearTimeout(timerRef.current);
        flush();
      }
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flush);
      window.clearTimeout(timerRef.current);
    };
  }, [flush]);

  /* ------------------------------------------------------------- realtime */

  /** Apply a scene that came from the other side of the websocket. */
  const applyRemote = useCallback((remote) => {
    const api = apiRef.current;
    if (!api || !remote) return;
    const state = api.getAppState();

    // never yank elements out from under a drag or an open text editor
    if (state.draggingElement || state.newElement || state.editingElement) {
      remoteRef.current = remote;
      window.clearTimeout(remoteTimerRef.current);
      remoteTimerRef.current = window.setTimeout(() => {
        const next = remoteRef.current;
        remoteRef.current = null;
        if (next) applyRemote(next);
      }, 250);
      return;
    }

    // this scene did not come from our slider: the drag base is stale now
    forgetResizeDrag();

    // Images live outside the element list: an image element only points at a
    // file id in `files`. Without the binary, the other side gets a blank image
    // (and can reject the whole scene), so merge files before the elements.
    const incomingFiles = remote.files && typeof remote.files === "object" ? remote.files : {};
    const knownFiles = api.getFiles() || {};
    const missingFiles = Object.values(incomingFiles).filter(
      (file) => file && typeof file.id === "string" && !knownFiles[file.id],
    );
    if (missingFiles.length) {
      try {
        api.addFiles(missingFiles);
      } catch (error) {
        console.error("[live] files", error);
      }
    }

    const local = api.getSceneElements();
    const merged = mergeElements(local, remote.elements || []);
    if (merged.changed) api.updateScene({ elements: merged.elements });

    const full = api.getSceneElements();
    const body = payloadFor(full, api.getAppState(), api.getFiles());
    window.clearTimeout(timerRef.current);
    pendingRef.current = null;
    // a queued write was just dropped; if what we now hold is what the file says,
    // say so instead of leaving the pill claiming a save that will never happen
    if (body === lastSavedRef.current || (lastSavedRef.current && stableOf(body) === stableOf(lastSavedRef.current))) {
      setSaveState((state) => (state.kind === "saving" ? { kind: "saved", at: Date.now() } : state));
    }

    if (merged.extra) {
      // the file on disk is the sender's scene, which lacks what we drew while
      // their update was in flight: publish ours on top of it
      lastSavedRef.current = payloadFor(remote.elements || [], api.getAppState(), api.getFiles());
      lastSentRef.current = null;
      queueSave(full, api.getAppState(), api.getFiles());
    } else {
      // nothing of ours is missing over there; treat the applied scene as saved
      // instead of bouncing it back. Excalidraw normalises elements as it
      // applies them, so both sides would otherwise look dirty forever.
      lastSavedRef.current = body;
      lastSentRef.current = body;
      // the queued save was dropped just above: the pill must not stay "saving"
      setSaveState((state) => (state.kind === "saving" ? { kind: "saved", at: Date.now() } : state));
    }
  }, [forgetResizeDrag, queueSave]);

  useEffect(() => {
    if (phase !== "ready" || !boardId) return undefined;

    let closed = false;
    let retry = 0;
    let reconnectTimer = 0;

    const connect = () => {
      const existing = wsRef.current;
      // one socket per tab: a second one would show up as a second person
      if (existing && (existing.readyState === 0 || existing.readyState === 1)) return;
      if (existing) {
        wsRef.current = null;
        try {
          existing.close(1000, "reconnecting");
        } catch {
          /* already gone */
        }
      }
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${proto}//${window.location.host}/ws/board/${encodeURIComponent(boardId)}?name=${encodeURIComponent(guestName())}&sid=${encodeURIComponent(sidRef.current)}`;
      let ws;
      try {
        ws = new WebSocket(url);
      } catch {
        setLive("closed");
        return;
      }
      wsRef.current = ws;
      setLive("connecting");


      ws.onopen = () => {
        if (closed) return;
        retry = 0;
        setLive("open");
      };

      ws.onmessage = (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.type === "welcome") {
          meRef.current = message.you;
        } else if (message.type === "presence") {
          setPeers(Array.isArray(message.peers) ? message.peers : []);
        } else if (message.type === "update") {
          applyRemote(message.scene);
        } else if (message.type === "saved") {
          if (lastSentRef.current) lastSavedRef.current = lastSentRef.current;
          pendingRef.current = null;
          setSaveState({ kind: "saved", at: Date.now() });
        } else if (message.type === "save-failed") {
          // keep nothing "in flight" so the retry can send the same scene again
          lastSentRef.current = null;
          setSaveState({ kind: "error", at: Date.now() });
        } else if (message.type === "deleted") {
          // do not let a pending flush PUT the file straight back
          goneRef.current = true;
          window.clearTimeout(timerRef.current);
          window.clearTimeout(remoteTimerRef.current);
          pendingRef.current = null;
          setFatal("กระดานนี้ถูกลบไปแล้ว");
        } else if (message.type === "meta") {
          // someone else renamed the board: the tab title follows it
          if (typeof message.title === "string" && message.title) {
            setTitle(message.title);
          }
        }
      };

      ws.onclose = (event) => {
        if (wsRef.current === ws) wsRef.current = null;
        if (closed) return;
        setLive("closed");
        setPeers([]);
        // whatever the socket did not confirm still has to reach the server
        if (pendingRef.current) void saveOverHttp();
        // 4001 = another page carrying this tab's session id took the slot over
        // (a reload whose old page was still alive); reconnecting would fight it
        if (event?.code === 4001) return;
        reconnectTimer = window.setTimeout(connect, Math.min(5000, 600 * 2 ** Math.min(retry, 4)));
        retry += 1;
      };

      ws.onerror = () => {};
    };

    // closing on the way out is what keeps the guest list honest; the server
    // heartbeat is the fallback for browsers that never get to run this
    const onPageHide = () => {
      const ws = wsRef.current;
      wsRef.current = null;
      if (!ws) return;
      try {
        ws.close(1000, "pagehide");
      } catch {
        /* already gone */
      }
    };
    const onPageShow = (event) => {
      if (event.persisted) connect(); // restored from the back/forward cache
    };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);

    connect();

    return () => {
      closed = true;
      window.clearTimeout(reconnectTimer);
      window.clearTimeout(remoteTimerRef.current);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) ws.close();
    };
  }, [phase, boardId, applyRemote, saveOverHttp]);

  /* grouped cells: a double-click isolates the cell inside the group instead of
     typing, so follow it with an Enter to start editing the bound text. */
  useEffect(() => {
    const onDoubleClick = () => {
      window.setTimeout(() => {
        const api = apiRef.current;
        if (!api) return;
        const state = api.getAppState();
        if (!state.editingGroupId) return;
        const ids = Object.keys(state.selectedElementIds || {});
        if (ids.length !== 1) return;
        const el = api.getSceneElements().find((item) => item.id === ids[0]);
        // the transparent frame also carries customData.grid, but it must never
        // become a text container: only real cells and class lines enter edit mode
        if (!isGridCell(el) && !el?.customData?.classLine && !el?.customData?.classTitle) return;
        const host = document.querySelector(".excalidraw") ?? document.body;
        host.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true,
          }),
        );
      }, 60);
    };
    window.addEventListener("dblclick", onDoubleClick, true);
    return () => window.removeEventListener("dblclick", onDoubleClick, true);
  }, []);

  /* ---------------------------------------------------------------- tables */

  /* ------------------------------------------------------------- grid sizing */

  const gridElements = useCallback((gridId) => {
    const api = apiRef.current;
    if (!api) return [];
    return api.getSceneElements().filter((el) => el.customData?.grid === gridId);
  }, []);

  const applyGrid = useCallback(
    (meta, spec) => {
      const api = apiRef.current;
      if (!api) throw new Error("editor ยังไม่พร้อม");
      if (!meta?.grid) throw new Error("คลิกเลือกช่องในตารางก่อน");

      forgetResizeDrag();
      const all = api.getSceneElements();
      const mine = all.filter((el) => el.customData?.grid === meta.grid);
      if (!mine.length) throw new Error("ไม่พบตารางที่เลือก");

      const cells = mine.filter((el) => isGridCell(el, meta.grid));
      const originX = Math.min(...mine.map((el) => el.x));
      const originY = Math.min(...mine.map((el) => el.y));

      const byId = new Map(mine.map((el) => [el.id, el]));
      const cellIds = new Set(mine.filter((el) => isGridCell(el, meta.grid)).map((el) => el.id));
      // a cell's text is bound by containerId, not by customData: pick up both
      // shapes so older boards (whose text lost customData) migrate cleanly
      const texts = new Map();
      for (const el of all) {
        if (el.type !== "text" || !el.text || !el.containerId) continue;
        if (!cellIds.has(el.containerId)) continue;
        const cellMeta = byId.get(el.containerId)?.customData;
        if (cellMeta) texts.set(`${cellMeta.r}:${cellMeta.c}`, el.text);
      }
      const staleText = new Set(
        all.filter((el) => el.type === "text" && el.containerId && cellIds.has(el.containerId)).map((el) => el.id),
      );

      const headEl = mine.find((el) => el.customData?.title);
      const subEl = mine.find((el) => el.customData?.subtitle);

      // the panel may ask for a new colour / header flag in the same update
      const color = spec.color ?? meta.color;
      const headerRow = spec.headerRow ?? meta.headerRow;

      const { elements } = buildGrid({
        columns: spec.columns,
        rows: spec.rows,
        width: spec.width,
        height: spec.height,
        colWidths: matchSizes(spec.colWidths ?? meta.colWidths, spec.columns),
        rowHeights: matchSizes(spec.rowHeights ?? meta.rowHeights, spec.rows),
        color,
        headerRow,
        gridId: meta.grid,
        // pin ids to the grid + slot: the rebuilt cells replace the old ones in
        // place, so one undo steps between two clean generations instead of
        // leaving the previous generation alive next to this one
        idPrefix: meta.grid,
        title: spec.title ?? headEl?.text ?? "",
        subtitle: spec.subtitle ?? subEl?.text ?? "",
      });

      const placed = elements.map((el) => ({ ...el, x: el.x + originX, y: el.y + originY }));
      // cells carry no text element until they hold something — restore the ones with text
      const restored = [];
      for (const el of placed) {
        if (!isGridCell(el, meta.grid)) continue;
        const value = texts.get(`${el.customData.r}:${el.customData.c}`);
        if (!value) continue;
        const { r, c } = el.customData;
        restored.push(
          attachCellText(el, value, {
            groupIds: el.groupIds ?? [],
            customData: { grid: meta.grid, r, c },
            id: `${el.id}-t`,
          }),
        );
      }
      const rebuilt = [...placed, ...restored];

      const firstCell = placed.find((el) => isGridCell(el, meta.grid));
      // Rebuild in place, not at the end of the scene: the frame must stay
      // below its cells (and the table below later elements), exactly like a
      // freshly inserted grid.
      const nextElements = [];
      let rebuiltPlaced = false;
      for (const el of all) {
        if (el.customData?.grid === meta.grid || staleText.has(el.id)) {
          if (!rebuiltPlaced) {
            nextElements.push(...rebuilt);
            rebuiltPlaced = true;
          }
          continue;
        }
        nextElements.push(el);
      }
      if (!rebuiltPlaced) nextElements.push(...rebuilt);
      api.updateScene({
        elements: nextElements,
        appState: { selectedElementIds: firstCell ? { [firstCell.id]: true } : {} },
        // one rebuild = one undo step; without this Excalidraw coalesces several
        // rebuilds into one entry and an undo lands on a half-applied scene
        captureUpdate: "IMMEDIATELY",
      });
      try {
        api.scrollToContent(rebuilt, { fitToContent: false, animate: true });
      } catch {
        /* nicety */
      }
      const after = api.getSceneElements();
      setSelectedGrid(describeGrid(after, meta.grid));
      queueSave(after, api.getAppState(), api.getFiles());
      return rebuilt.length;
    },
    [describeGrid, forgetResizeDrag, queueSave],
  );

  const growGrid = useCallback(
    (meta, axis) => {
      const mine = gridElements(meta?.grid);
      const metrics = gridMetrics(mine, meta?.grid);
      if (!metrics) throw new Error("คลิกเลือกช่องในตารางก่อน");
      const rowHeights = metrics.rows.map((row) => Math.round(row.height));
      const colWidths = metrics.cols.map((col) => Math.round(col.width));
      const avgRow = Math.round(rowHeights.reduce((a, b) => a + b, 0) / Math.max(1, rowHeights.length));
      const avgCol = Math.round(colWidths.reduce((a, b) => a + b, 0) / Math.max(1, colWidths.length));
      const spec =
        axis === "row"
          ? {
              columns: meta.cols,
              rows: meta.rows + 1,
              width: metrics.bounds.width,
              height: metrics.bounds.height + avgRow,
              rowHeights: [...rowHeights, avgRow],
              colWidths,
            }
          : {
              columns: meta.cols + 1,
              rows: meta.rows,
              width: metrics.bounds.width + avgCol,
              height: metrics.bounds.height,
              rowHeights,
              colWidths: [...colWidths, avgCol],
            };
      return applyGrid(meta, spec);
    },
    [applyGrid, gridElements],
  );

  /* --------------------------------------------------- table row/column sizes */

  /**
   * Resize one track of the selected grid. `capture` decides whether Excalidraw
   * records an undo step ("NEVER" for live previews, "IMMEDIATELY" for real work)
   * and `rewrap: false` skips the text measuring pass while a slider is moving.
   */
  const applyResize = useCallback(
    (meta, axis, index, size, { base, rewrap = true, capture = "IMMEDIATELY" } = {}) => {
      const api = apiRef.current;
      if (!api || !meta?.grid) throw new Error("คลิกเลือกช่องในตารางก่อน");
      const source = base ?? api.getSceneElements();
      const resize = axis === "row" ? resizeGridRow : resizeGridColumn;
      const result = resize(source, meta.grid, index, size, { rewrap });
      if (!result.changed) return null;
      // hand over the finished shape, not a half-finished one: every text has to
      // fit its cell before the entry is captured, otherwise Excalidraw grows the
      // cell itself right after the update and the undo/redo pair disagrees
      const healed = healGrid(result.elements, meta.grid) ?? result.elements;
      api.updateScene({ elements: healed, captureUpdate: capture });
      return result;
    },
    [],
  );

  /** Live feedback while a slider is dragged: never undoable, never saved. */
  const previewResize = useCallback(
    (meta, axis, index, size) => {
      const api = apiRef.current;
      if (!api || !meta?.grid) return;
      const drag = resizeDragRef.current;
      if (!drag || drag.grid !== meta.grid || drag.axis !== axis || drag.index !== index || drag.epoch !== sceneEpochRef.current) {
        // remember where the drag started so the commit can replay it as one step
        resizeDragRef.current = {
          grid: meta.grid,
          axis,
          index,
          epoch: sceneEpochRef.current,
          elements: api.getSceneElements(),
        };
      }
      if (resizeFrameRef.current) return;
      resizeFrameRef.current = requestAnimationFrame(() => {
        resizeFrameRef.current = 0;
        applyResize(meta, axis, index, size, { rewrap: false, capture: "NEVER" });
      });
    },
    [applyResize],
  );

  /** Final size: one undo step and one save, however many previews came before. */
  const commitResize = useCallback(
    (meta, axis, index, size) => {
      const api = apiRef.current;
      if (!api || !meta?.grid) throw new Error("คลิกเลือกช่องในตารางก่อน");
      if (resizeFrameRef.current) {
        cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = 0;
      }
      const drag = resizeDragRef.current;
      resizeDragRef.current = null;
      const sameDrag =
        drag && drag.grid === meta.grid && drag.axis === axis && drag.index === index && drag.epoch === sceneEpochRef.current;
      if (sameDrag) {
        // the previews were never captured, so rewind first: the captured update
        // then replays the whole drag instead of just its last pixel of movement
        api.updateScene({ elements: drag.elements, captureUpdate: "NEVER" });
      }
      const result = applyResize(meta, axis, index, size, {
        base: sameDrag ? drag.elements : undefined,
        rewrap: true,
        capture: "IMMEDIATELY",
      });
      const after = api.getSceneElements();
      if (result) {
        setSelectedGrid(describeGrid(after, meta.grid));
        queueSave(after, api.getAppState(), api.getFiles());
      }
      return Boolean(result);
    },
    [applyResize, describeGrid, queueSave],
  );

  /** Size one row (index r) of the selected grid; keeps everything below it in place. */
  const resizeRow = useCallback((meta, r, height) => commitResize(meta, "row", r, height), [commitResize]);

  /** Size one column (index c) of the selected grid; text rewraps to the new width. */
  const resizeCol = useCallback((meta, c, width) => commitResize(meta, "col", c, width), [commitResize]);

  const insertTable = useCallback(
    (spec) => {
      const api = apiRef.current;
      if (!api) throw new Error("editor ยังไม่พร้อม");

      if (spec.kind === "class") {
        const built = buildClass(spec);
        const current = api.getSceneElements();
        let right = -Infinity;
        for (const el of current) {
          if (el.isDeleted) continue;
          right = Math.max(right, el.x + (el.width || 0));
        }
        const offsetX = Number.isFinite(right) ? Math.round(right) + 120 : 0;
        const placed = built.elements.map((el) => ({ ...el, x: el.x + offsetX }));
        api.updateScene({
          elements: [...current, ...placed],
          appState: { selectedElementIds: { [built.frameId]: true } },
        });
        try {
          api.scrollToContent(placed, { fitToContent: false, animate: true });
        } catch {
          /* scrolling is a nicety */
        }
        queueSave(api.getSceneElements(), api.getAppState(), api.getFiles());
        return placed.length;
      }

      const { elements: fresh } = buildGrid(spec);
      const current = api.getSceneElements();

      let right = -Infinity;
      for (const el of current) {
        if (el.isDeleted) continue;
        right = Math.max(right, el.x + (el.width || 0));
      }
      const offsetX = Number.isFinite(right) ? Math.round(right) + 120 : 0;
      const placed = fresh.map((el) => ({ ...el, x: el.x + offsetX }));

      api.updateScene({ elements: [...current, ...placed] });
      try {
        api.scrollToContent(placed, { fitToContent: false, animate: true });
      } catch {
        /* scrolling is a nicety */
      }

      queueSave(api.getSceneElements(), api.getAppState(), api.getFiles());
      return placed.length;
    },
    [queueSave],
  );

  /** Rebuild a selected UML class from the panel. */
  const applyClass = useCallback(
    (meta, spec) => {
      const api = apiRef.current;
      if (!api) throw new Error("editor ยังไม่พร้อม");
      if (!meta?.grid) throw new Error("คลิกเลือก UML class ก่อน");
      const result = updateClass(api.getSceneElements(), meta.grid, {
        ...spec,
        kind: "class",
      });
      if (!result) return 0;
      api.updateScene({
        elements: result.elements,
        appState: { selectedElementIds: { [result.frameId]: true } },
        captureUpdate: "IMMEDIATELY",
      });
      const after = api.getSceneElements();
      setSelectedClass(describeClass(after, meta.grid));
      try {
        api.scrollToContent(
          after.filter((el) => el.customData?.grid === meta.grid),
          { fitToContent: false, animate: true },
        );
      } catch {
        /* nicety */
      }
      queueSave(after, api.getAppState(), api.getFiles());
      return result.count;
    },
    [queueSave],
  );

  /** Clone the table under a hover handle, then link source and clone. */
  const cloneTable = useCallback(
    (gridId, direction) => {
      const api = apiRef.current;
      if (!api) return;
      try {
        const result = cloneAndConnect(api.getSceneElements(), gridId, direction);
        const cloneElements = result.elements.filter((el) => el.customData?.grid === result.cloneGridId);
        const selectedElementIds = {};
        for (const el of cloneElements) selectedElementIds[el.id] = true;
        api.updateScene({
          elements: result.elements,
          appState: { selectedElementIds },
          captureUpdate: "IMMEDIATELY",
        });
        const cloneFrame = cloneElements.find((el) => el.customData?.frame);
        if (cloneFrame) {
          try {
            api.scrollToContent(cloneFrame, { fitToContent: false, animate: true });
          } catch {
            /* scrolling is a nicety */
          }
        }
        queueSave(api.getSceneElements(), api.getAppState(), api.getFiles());
      } catch (error) {
        console.error("clone table failed", error);
      }
    },
    [queueSave],
  );

  /** Persist the scene after a waypoint drag (the drag itself is live). */
  const commitRelationRoute = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    queueSave(api.getSceneElements(), api.getAppState(), api.getFiles());
  }, [queueSave]);

  /** Change the cardinality heads of one selected relation arrow. */
  const setRelationPreset = useCallback(
    (arrowId, presetId) => {
      const api = apiRef.current;
      if (!api) return;
      const next = applyCardinalityToElements(api.getSceneElements(), arrowId, presetId);
      if (!next) return;
      api.updateScene({ elements: next, captureUpdate: "IMMEDIATELY" });
      queueSave(api.getSceneElements(), api.getAppState(), api.getFiles());
    },
    [queueSave],
  );

  /* Which cell did the user just click? The table panel uses it to aim the
     row/column size fields and the overlay highlights that row and column. */
  useEffect(() => {
    if (phase !== "ready") return undefined;
    const host = canvasRef.current;
    if (!host) return undefined;
    const onDown = (event) => {
      const api = apiRef.current;
      if (!api || event.button !== 0) return;
      const state = api.getAppState();
      const zoom = state.zoom?.value || 1;
      const rect = host.getBoundingClientRect();
      const sceneX = (event.clientX - rect.left) / zoom - (state.scrollX || 0);
      const sceneY = (event.clientY - rect.top) / zoom - (state.scrollY || 0);
      const cell = api.getSceneElements().find(
        (el) =>
          isGridCell(el) &&
          sceneX >= el.x &&
          sceneX <= el.x + el.width &&
          sceneY >= el.y &&
          sceneY <= el.y + el.height,
      );
      setActiveCell(
        cell ? { grid: cell.customData.grid, r: cell.customData.r, c: cell.customData.c } : null,
      );
    };
    host.addEventListener("pointerdown", onDown, true);
    return () => host.removeEventListener("pointerdown", onDown, true);
  }, [phase, scene]);

  /* The +/- control is a scene element, so it travels with the class. Catching
     its pointerdown before Excalidraw selects the group keeps the click a
     toggle instead of a drag/selection. */
  useEffect(() => {
    if (phase !== "ready") return undefined;
    const host = canvasRef.current;
    if (!host) return undefined;
    const onDown = (event) => {
      const api = apiRef.current;
      if (!api || event.button !== 0) return;
      const state = api.getAppState();
      const zoom = state.zoom?.value || 1;
      const rect = host.getBoundingClientRect();
      const sceneX = (event.clientX - rect.left) / zoom - (state.scrollX || 0);
      const sceneY = (event.clientY - rect.top) / zoom - (state.scrollY || 0);
      const hit = api
        .getSceneElements()
        .find(
          (el) =>
            !el.isDeleted &&
            el.customData?.classToggle &&
            sceneX >= el.x &&
            sceneX <= el.x + el.width &&
            sceneY >= el.y &&
            sceneY <= el.y + el.height,
        );
      if (!hit) return;
      event.preventDefault();
      event.stopPropagation();
      const result = toggleClass(api.getSceneElements(), hit.customData.grid);
      if (!result) return;
      api.updateScene({
        elements: result.elements,
        appState: { selectedElementIds: { [result.frameId]: true } },
        captureUpdate: "IMMEDIATELY",
      });
      queueSave(api.getSceneElements(), api.getAppState(), api.getFiles());
    };
    host.addEventListener("pointerdown", onDown, true);
    return () => host.removeEventListener("pointerdown", onDown, true);
  }, [phase, queueSave, scene]);

  /* ---------------------------------------------------------------- render */

  if (phase === "error") {
    return (
      <div className="fatal">
        <h1>เปิดกระดานไม่ได้</h1>
        <p>{fatal}</p>
        <a className="btn" href="/">
          ← กลับไปแกลเลอรี
        </a>
      </div>
    );
  }

  if (phase === "loading") {
    return <div className="fatal loading">กำลังโหลดกระดาน…</div>;
  }

  const others = peers.filter((p) => p.id !== meRef.current?.id);
  const liveLabel = live === "open" ? `${peers.length} คน` : live === "connecting" ? "กำลังเชื่อมต่อ…" : "ออฟไลน์";
  const liveTitle = others.length ? others.map((p) => p.name).join(", ") : "ยังไม่มีคนอื่นเข้ามาในกระดานนี้";
  const MAX_AVATARS = 4;
  const shownPeers = peers.slice(0, MAX_AVATARS);
  const extraPeers = Math.max(0, peers.length - shownPeers.length);
  const presenceTitle = live === "open" ? liveTitle : liveLabel;
  const presenceLabel =
    live === "open"
      ? `คนในกระดานนี้ ${peers.length} คน`
      : live === "connecting"
        ? "กำลังเชื่อมต่อกับกระดานนี้"
        : "ออฟไลน์";

  const savedTime = saveState.at
    ? new Date(saveState.at).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" })
    : "";
  const saveLabel =
    saveState.kind === "saving"
      ? "กำลังบันทึกการเปลี่ยนแปลง"
      : saveState.kind === "error"
        ? "บันทึกไม่สำเร็จ กดเพื่อลองใหม่"
        : savedTime
          ? `บันทึกแล้วเมื่อ ${savedTime}`
          : "บันทึกแล้ว";
  const savePill = (
    <button
      type="button"
      className={`save-pill ${saveState.kind}`}
      onClick={retrySave}
      aria-live="polite"
      aria-label={saveLabel}
      title={saveLabel}
      // status, not a control: only a failed save offers the retry
      disabled={saveState.kind !== "error"}
    >
      <span className="save-dot" aria-hidden="true" />
      <span className="save-text">
        {saveState.kind === "saving" ? "กำลังบันทึก…" : saveState.kind === "error" ? "บันทึกไม่สำเร็จ" : "บันทึกแล้ว"}
      </span>
      {saveState.kind === "saved" && savedTime ? <span className="save-time">{savedTime}</span> : null}
    </button>
  );

  const themeButton = (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggleTheme}
      aria-label={theme === "dark" ? "สลับเป็นโหมดสว่าง" : "สลับเป็นโหมดมืด"}
      aria-pressed={theme === "dark"}
      title={theme === "dark" ? "โหมดสว่าง" : "โหมดมืด"}
    >
      {theme === "dark" ? <IconSun /> : <IconMoon />}
    </button>
  );

  const presenceNode = (
    <div
      className={`presence ${live}${presenceHost ? " docked" : ""}`}
      ref={presenceRef}
      title={presenceTitle}
      aria-label={presenceLabel}
    >
      {live === "open" ? (
        <>
          <span className="presence-avatars">
            {shownPeers.map((peer) => (
              <span
                key={peer.id}
                className="presence-avatar"
                style={{ background: peer.color, color: avatarInk(peer.color) }}
                title={peer.name}
              >
                {avatarInitial(peer.name)}
              </span>
            ))}
            {extraPeers > 0 && (
              <span className="presence-avatar presence-more" title={presenceTitle}>
                +{extraPeers}
              </span>
            )}
          </span>
          <span className="presence-count">{liveLabel}</span>
        </>
      ) : (
        <span className="presence-state">
          <i />
          {liveLabel}
        </span>
      )}
    </div>
  );

  return (
    <div className={`shell${panelOpen ? " panel-open" : ""}${toolsReady && toolsCollapsed ? " tools-collapsed" : ""}`}>
      {presenceHost ? (
        createPortal(
          <span className="top-actions docked">
            {savePill}
            {themeButton}
            {presenceNode}
          </span>,
          presenceHost,
        )
      ) : (
        <span className="top-actions">
          {savePill}
          {themeButton}
          {presenceNode}
        </span>
      )}
      {tableSlot &&
        createPortal(
          <>
            <button
              type="button"
              className={`tools-table${panelOpen ? " active" : ""}`}
              onClick={() => setPanelOpen((v) => !v)}
              aria-label="เปิดตัวสร้างตาราง"
              aria-pressed={panelOpen}
              title="สร้าง/แก้ตาราง"
            >
              <IconTable />
            </button>
            <button
              type="button"
              className={`tools-minimap${minimapOn ? " active" : ""}`}
              onClick={() => setMinimapOn((v) => !v)}
              aria-label={minimapOn ? "ซ่อนแผนที่ย่อ" : "แสดงแผนที่ย่อ"}
              aria-pressed={minimapOn}
              title={minimapOn ? "ซ่อนแผนที่ย่อ" : "แสดงแผนที่ย่อ"}
            >
              <IconMinimap />
            </button>
          </>,
          tableSlot,
        )}
      <LassoTool apiRef={apiRef} canvasRef={canvasRef} host={tableSlot} />
      <a className="back-fab" href="/" aria-label="กลับไปหน้ารวมกระดาน" title="กลับไปหน้ารวมกระดาน">
        <IconBack />
      </a>

      <div className="canvas" ref={canvasRef}>
        <Excalidraw
          theme={theme}
          initialData={{
            elements: scene.elements || [],
            appState: { ...(scene.appState || {}), theme },
            files: scene.files || {},
            scrollToContent: true,
          }}
          onChange={onChange}
          excalidrawAPI={(api) => {
            apiRef.current = api;
            window.__boardsApi = api; // handy for the e2e harness
          }}
        />
        <GridOverlay apiRef={apiRef} canvasRef={canvasRef} activeCell={activeCell} />
        <TableHoverArrows apiRef={apiRef} canvasRef={canvasRef} onClone={cloneTable} />
        <RelationPanel
          apiRef={apiRef}
          canvasRef={canvasRef}
          selected={selectedRelation}
          onApply={setRelationPreset}
        />
        <RelationWaypoints
          apiRef={apiRef}
          canvasRef={canvasRef}
          selected={selectedRelation}
          onCommit={commitRelationRoute}
        />
        <Minimap
              apiRef={apiRef}
              theme={theme}
              visible={minimapOn}
              folded={minimapFolded}
              onToggle={() => setMinimapFolded((folded) => !folded)}
            />
      </div>

      {toolsReady && toolsCollapsed && toolsPos && (
        <button
          type="button"
          className="tools-launcher"
          ref={launcherRef}
          style={{ left: toolsPos.x, top: toolsPos.y }}
          onClick={(event) => {
            // A drag ends with a click event; that click must not open the row.
            if (launcherMovedRef.current) {
              launcherMovedRef.current = false;
              event.preventDefault();
              return;
            }
            setToolsCollapsed(false);
          }}
          aria-label="แสดงเครื่องมือวาด"
          title="ลากเพื่อย้าย · คลิกเพื่อกางเครื่องมือวาด"
        >
          <IconTools />
          <span>เครื่องมือ</span>
        </button>
      )}

      <TableBuilder
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        onInsert={insertTable}
        selected={selectedClass ?? selectedGrid}
        onUpdate={(spec) =>
          spec.kind === "class" ? applyClass(selectedClass, spec) : applyGrid(selectedGrid, spec)
        }
        onGrow={(axis) => growGrid(selectedGrid, axis)}
        active={selectedClass ? null : activeCell}
        onResizeRow={(r, h) => resizeRow(selectedGrid, r, h)}
        onResizeCol={(c, w) => resizeCol(selectedGrid, c, w)}
        onPreviewRow={(r, h) => previewResize(selectedGrid, "row", r, h)}
        onPreviewCol={(c, w) => previewResize(selectedGrid, "col", c, w)}
      />
    </div>
  );
}
