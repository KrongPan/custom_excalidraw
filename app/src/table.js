/* ------------------------------------------------------------------ constants */

const FONT_SANS = 2; // Helvetica
const FONT_MONO = 3; // Cascadia Code
const LINE_HEIGHT = 1.25;
const CELL_PAD_X = 12;
const CELL_PAD_Y = 8;
const HEADER_FONT = 13;
const CELL_FONT = 13;
const TITLE_FONT = 16;
const SUBTITLE_FONT = 12;
const TITLE_GAP = 10;
const MUTED = "#868e96";
const MIN_COL_W = 56;
const MAX_COL_W = 460;
const MIN_ROW_H = 30;
const HEADER_H = 34;

const INK = "#1e1e1e";
const RULE = "#dee2e6";

const PALETTE = {
  gray: { fill: "#f1f3f5", stroke: "#868e96" },
  blue: { fill: "#e7f5ff", stroke: "#1971c2" },
  green: { fill: "#d3f9d8", stroke: "#2f9e44" },
  yellow: { fill: "#fff3bf", stroke: "#f08c00" },
  orange: { fill: "#ffe8cc", stroke: "#e8590c" },
  red: { fill: "#ffe3e3", stroke: "#e03131" },
  violet: { fill: "#f3f0ff", stroke: "#6741d9" },
  cyan: { fill: "#e3fafc", stroke: "#0c8599" },
};

/* ------------------------------------------------------------- text measuring */

// Helvetica advance widths (per 1000 units, /1000 => em fraction), plus fallbacks.
const HELV = {
  " ": 0.278, "!": 0.278, '"': 0.355, "#": 0.556, $: 0.556, "%": 0.889, "&": 0.667,
  "'": 0.191, "(": 0.333, ")": 0.333, "*": 0.389, "+": 0.584, ",": 0.278, "-": 0.333,
  ".": 0.278, "/": 0.278, ":": 0.278, ";": 0.278, "<": 0.584, "=": 0.584, ">": 0.584,
  "?": 0.556, "@": 1.015, "[": 0.278, "\\": 0.278, "]": 0.278, "^": 0.469, _: 0.556,
  "`": 0.333, "{": 0.334, "|": 0.26, "}": 0.334, "~": 0.584,
  a: 0.556, b: 0.556, c: 0.5, d: 0.556, e: 0.556, f: 0.278, g: 0.556, h: 0.556,
  i: 0.222, j: 0.222, k: 0.5, l: 0.222, m: 0.833, n: 0.556, o: 0.556, p: 0.556,
  q: 0.556, r: 0.333, s: 0.5, t: 0.278, u: 0.556, v: 0.5, w: 0.722, x: 0.5,
  y: 0.5, z: 0.5,
  A: 0.667, B: 0.667, C: 0.722, D: 0.722, E: 0.667, F: 0.611, G: 0.778, H: 0.722,
  I: 0.278, J: 0.5, K: 0.667, L: 0.556, M: 0.833, N: 0.722, O: 0.778, P: 0.667,
  Q: 0.778, R: 0.722, S: 0.667, T: 0.611, U: 0.722, V: 0.667, W: 0.944, X: 0.667,
  Y: 0.667, Z: 0.611,
};

const THAI_MARKS = new Set([
  0x0e31, 0x0e34, 0x0e35, 0x0e36, 0x0e37, 0x0e38, 0x0e39, 0x0e3a,
  0x0e47, 0x0e48, 0x0e49, 0x0e4a, 0x0e4b, 0x0e4c, 0x0e4d, 0x0e4e,
]);

function isWideScript(code) {
  return (
    (code >= 0x0e00 && code <= 0x0e7f) || // Thai
    (code >= 0x1100 && code <= 0x11ff) || // Hangul Jamo
    (code >= 0x2e80 && code <= 0xa4cf) || // CJK
    (code >= 0xac00 && code <= 0xd7af) || // Hangul
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xff60)
  );
}

function charEm(ch) {
  const code = ch.codePointAt(0);
  if (code === undefined) return 0;
  if (THAI_MARKS.has(code)) return 0.32;
  if (isWideScript(code)) return code <= 0x0e7f ? 0.6 : 1;
  if (code >= 0x0300 && code <= 0x036f) return 0.2;
  return HELV[ch] ?? 0.58;
}

function measure(text, fontSize, fontFamily) {
  if (fontFamily === FONT_MONO) return text.length * 0.6 * fontSize;
  let em = 0;
  for (const ch of text) em += charEm(ch);
  return em * fontSize;
}

/** Greedy wrap; breaks long tokens (and unspaced Thai) character by character. */
function wrap(text, maxWidth, fontSize, fontFamily) {
  const paragraphs = String(text).split("\n");
  const out = [];
  for (const para of paragraphs) {
    if (para === "") {
      out.push("");
      continue;
    }
    const words = para.split(/(\s+)/).filter((w) => w !== "");
    let line = "";
    for (const word of words) {
      const candidate = line + word;
      if (measure(candidate, fontSize, fontFamily) <= maxWidth || line === "") {
        if (measure(word, fontSize, fontFamily) > maxWidth) {
          // single token wider than the cell: hard-break it
          let chunk = "";
          for (const ch of word) {
            if (measure(chunk + ch, fontSize, fontFamily) > maxWidth && chunk !== "") {
              out.push(chunk);
              chunk = ch;
            } else {
              chunk += ch;
            }
          }
          line = chunk;
        } else {
          line = candidate;
        }
      } else {
        out.push(line.trimEnd());
        line = word.trimStart();
      }
    }
    out.push(line.trimEnd());
  }
  return out.length ? out : [""];
}

/* ------------------------------------------------------------- element output */

let seedState = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
function rnd() {
  seedState = (seedState + 0x6d2b79f5) | 0;
  let t = Math.imul(seedState ^ (seedState >>> 15), 1 | seedState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const randInt = (n) => Math.floor(rnd() * n);

let idSeq = 0;
function nextId(prefix = "t") {
  idSeq += 1;
  return `${prefix}${idSeq.toString(36)}${randInt(1e9).toString(36)}`;
}

const round = (n) => Math.round(n * 100) / 100;
const stamp = Date.now();

function base(type, x, y, width, height, o = {}) {
  return {
    id: o.id ?? nextId(type[0]),
    type,
    x: round(x),
    y: round(y),
    width: round(width),
    height: round(height),
    angle: 0,
    strokeColor: o.strokeColor ?? INK,
    backgroundColor: o.backgroundColor ?? "transparent",
    fillStyle: "solid",
    strokeWidth: o.strokeWidth ?? 1,
    strokeStyle: o.strokeStyle ?? "solid",
    roughness: o.roughness ?? 1,
    opacity: 100,
    groupIds: o.groupIds ?? [],
    frameId: null,
    roundness: o.roundness ?? null,
    seed: randInt(2 ** 31),
    version: 1,
    versionNonce: randInt(2 ** 31),
    isDeleted: false,
    boundElements: null,
    updated: stamp,
    link: null,
    locked: false,
  };
}

function rect(x, y, w, h, o = {}) {
  return base("rectangle", x, y, w, h, o);
}

function line(x, y, w, o = {}) {
  return {
    ...base("line", x, y, w, 0, { strokeWidth: 1, strokeColor: RULE, ...o }),
    points: [
      [0, 0],
      [round(w), 0],
    ],
    lastCommittedPoint: null,
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: null,
  };
}

function vline(x, y, h, o = {}) {
  return {
    ...base("line", x, y, 0, h, { strokeWidth: 1, strokeColor: RULE, ...o }),
    points: [
      [0, 0],
      [0, round(h)],
    ],
    lastCommittedPoint: null,
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: null,
  };
}

function text(x, y, value, fontSize, fontFamily, o = {}) {
  const lines = value.split("\n");
  const w = Math.max(...lines.map((l) => measure(l, fontSize, fontFamily)));
  const h = lines.length * fontSize * LINE_HEIGHT;
  return {
    ...base("text", x, y, w, h, { strokeColor: o.color ?? INK, roughness: 0, ...o }),
    text: value,
    originalText: value,
    fontSize,
    fontFamily,
    textAlign: "left",
    verticalAlign: "top",
    containerId: null,
    autoResize: true,
    lineHeight: LINE_HEIGHT,
    baseline: Math.round(fontSize * 0.9),
  };
}

/* ------------------------------------------------------------------- building */

function normalizeSpec(raw) {
  const spec = Array.isArray(raw) ? { tables: raw } : raw;
  if (!spec || !Array.isArray(spec.tables) || spec.tables.length === 0) {
    throw new Error("spec must contain a non-empty 'tables' array (or be an array of tables)");
  }
  return spec;
}

function normalizeColumns(table) {
  const cols = table.columns ?? [];
  if (!Array.isArray(cols) || cols.length === 0) {
    throw new Error(`table "${table.title ?? "?"}" has no columns`);
  }
  return cols.map((c) => {
    const col = typeof c === "string" ? { header: c } : { ...c };
    col.header = String(col.header ?? "");
    col.align = col.align ?? "left";
    return col;
  });
}

function buildTable(table, specDefaults) {
  const cols = normalizeColumns(table);
  const rows = (table.rows ?? []).map((r) =>
    cols.map((_, i) => (r[i] === undefined || r[i] === null ? "" : String(r[i]))),
  );
  const colorName = table.color ?? specDefaults.color ?? "gray";
  const palette = PALETTE[colorName] ?? PALETTE.gray;
  const fontSize = table.fontSize ?? specDefaults.fontSize ?? CELL_FONT;
  const fontFamily = (table.mono ?? specDefaults.mono) ? FONT_MONO : FONT_SANS;
  const groupId = nextId("g");
  const rounded = table.round ?? specDefaults.round ?? false;

  // natural column widths from header + cells, honoring explicit widths
  const widths = cols.map((col, i) => {
    if (col.width) return Math.max(MIN_COL_W, Math.min(MAX_COL_W, col.width));
    let widest = measure(col.header, HEADER_FONT, fontFamily);
    for (const row of rows) widest = Math.max(widest, measure(row[i], fontSize, fontFamily));
    return Math.max(MIN_COL_W, Math.min(MAX_COL_W, Math.ceil(widest + CELL_PAD_X * 2 + 6)));
  });

  // wrap every cell once; row height is driven by the tallest cell in the row
  const inner = widths.map((w) => w - CELL_PAD_X * 2);
  const headerLines = cols.map((col, i) => wrap(col.header, inner[i], HEADER_FONT, fontFamily));
  const bodyLines = rows.map((row) =>
    row.map((cell, i) => wrap(cell, inner[i], fontSize, fontFamily)),
  );
  const headerH = Math.max(
    HEADER_H,
    Math.max(...headerLines.map((l) => l.length)) * HEADER_FONT * LINE_HEIGHT + CELL_PAD_Y * 2,
  );
  const rowHeights = bodyLines.map((cells) =>
    Math.max(
      MIN_ROW_H,
      Math.max(...cells.map((l) => l.length)) * fontSize * LINE_HEIGHT + CELL_PAD_Y * 2,
    ),
  );
  const cardW = widths.reduce((a, b) => a + b, 0);
  const cardH = headerH + rowHeights.reduce((a, b) => a + b, 0);

  const elements = [];
  const g = (el) => {
    el.groupIds = [groupId];
    elements.push(el);
    return el;
  };

  const titleText = table.title ? String(table.title) : null;
  const subtitleText = table.subtitle ? String(table.subtitle) : null;
  const titleH =
    (titleText ? TITLE_FONT * LINE_HEIGHT : 0) +
    (subtitleText ? SUBTITLE_FONT * LINE_HEIGHT + 2 : 0) +
    (titleText || subtitleText ? TITLE_GAP : 0);
  const originX = 0;
  const originY = titleH;

  // card + header
  g(
    rect(originX, originY, cardW, cardH, {
      strokeColor: palette.stroke,
      backgroundColor: "#ffffff",
      roundness: rounded ? { type: 3 } : null,
      strokeWidth: 1,
    }),
  );
  g(
    rect(originX, originY, cardW, headerH, {
      strokeColor: palette.stroke,
      backgroundColor: palette.fill,
      roundness: rounded ? { type: 3 } : null,
      strokeWidth: 1,
    }),
  );

  if (titleText) {
    g(text(originX, 0, titleText, TITLE_FONT, FONT_SANS, { color: INK, roughness: 0 }));
  }
  if (subtitleText) {
    const y = titleText ? TITLE_FONT * LINE_HEIGHT : 0;
    g(text(originX, y, subtitleText, SUBTITLE_FONT, FONT_SANS, { color: MUTED, roughness: 0 }));
  }

  // header labels
  let cx = originX;
  cols.forEach((col, i) => {
    const lines = headerLines[i];
    const w = Math.max(...lines.map((l) => measure(l, HEADER_FONT, fontFamily)));
    const x =
      col.align === "right"
        ? cx + widths[i] - CELL_PAD_X - w
        : col.align === "center"
          ? cx + (widths[i] - w) / 2
          : cx + CELL_PAD_X;
    const y = originY + (headerH - lines.length * HEADER_FONT * LINE_HEIGHT) / 2;
    g(text(x, y, lines.join("\n"), HEADER_FONT, fontFamily, { color: INK, roughness: 0 }));
    cx += widths[i];
  });

  // body rows
  let rowTop = originY + headerH;
  bodyLines.forEach((cells, r) => {
    const rowH = rowHeights[r];
    if (r > 0) g(line(originX, rowTop, cardW));
    let x = originX;
    cells.forEach((lines, i) => {
      if (lines.length === 1 && lines[0] === "") {
        x += widths[i];
        return;
      }
      const w = Math.max(...lines.map((l) => measure(l, fontSize, fontFamily)));
      const col = cols[i];
      const tx =
        col.align === "right"
          ? x + widths[i] - CELL_PAD_X - w
          : col.align === "center"
            ? x + (widths[i] - w) / 2
            : x + CELL_PAD_X;
      const ty = rowTop + (rowH - lines.length * fontSize * LINE_HEIGHT) / 2;
      g(text(tx, ty, lines.join("\n"), fontSize, fontFamily, { color: INK, roughness: 0 }));
      x += widths[i];
    });
    rowTop += rowH;
  });

  return {
    elements,
    width: Math.max(
      cardW,
      titleText ? measure(titleText, TITLE_FONT, FONT_SANS) : 0,
      subtitleText ? measure(subtitleText, SUBTITLE_FONT, FONT_SANS) : 0,
    ),
    height: titleH + cardH,
  };
}

function layout(tables, columns, gapX, gapY) {
  const grid = [];
  tables.forEach((t, i) => {
    const col = i % columns;
    const row = Math.floor(i / columns);
    (grid[row] ??= []);
    grid[row][col] = t;
  });

  const colW = new Array(columns).fill(0);
  const rowH = new Array(grid.length).fill(0);
  grid.forEach((row, r) => {
    row.forEach((t, c) => {
      if (!t) return;
      colW[c] = Math.max(colW[c], t.width);
      rowH[r] = Math.max(rowH[r], t.height);
    });
  });

  const xAt = [];
  let acc = 0;
  for (let c = 0; c < columns; c += 1) {
    xAt.push(acc);
    acc += colW[c] + gapX;
  }
  const yAt = [];
  acc = 0;
  for (let r = 0; r < grid.length; r += 1) {
    yAt.push(acc);
    acc += rowH[r] + gapY;
  }

  const placed = [];
  tables.forEach((t, i) => {
    const c = i % columns;
    const r = Math.floor(i / columns);
    placed.push({ ...t, x: xAt[c], y: yAt[r] });
  });
  return placed;
}

/* ------------------------------------------------------------- browser wrapper */

/**
 * Build a grid of tables as Excalidraw elements.
 *
 * @param {object} input
 * @param {object[]} input.tables   table specs (title/subtitle/color/columns/rows)
 * @param {number} [input.columns]  grid columns for the layout
 * @param {number} [input.gapX]
 * @param {number} [input.gapY]
 * @returns {{elements: object[], width: number, height: number}}
 */
export function buildTables({ tables, columns = 1, gapX = 80, gapY = 60 }) {
  if (!Array.isArray(tables) || tables.length === 0) {
    throw new Error("buildTables needs at least one table");
  }
  const built = tables.map((table) => buildTable(table, {}));
  const placed = layout(built, Math.max(1, columns | 0), gapX, gapY);

  const elements = [];
  let maxX = 0;
  let maxY = 0;
  for (const table of placed) {
    for (const el of table.elements) {
      el.x = round(el.x + table.x);
      el.y = round(el.y + table.y);
      if (el.type === "line") el.points = el.points.map(([px, py]) => [round(px), round(py)]);
      elements.push(el);
      maxX = Math.max(maxX, el.x + (el.width || 0));
      maxY = Math.max(maxY, el.y + (el.height || 0));
    }
  }
  return { elements, width: maxX, height: maxY };
}

/* --------------------------------------------------------------- empty grid */

const clampInt = (value, lo, hi, fallback) => {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
};

/**
 * Build an empty row × column grid with an explicit overall width and height.
 *
 * Cells are plain rectangles in one group: no hidden text element is created up
 * front. Double-clicking a cell (or pressing Enter with it selected) makes
 * Excalidraw create the bound text on demand, so only cells that actually hold
 * something carry a text element.
 *
 * @param {object} input
 * @param {number} [input.columns] 1–20
 * @param {number} [input.rows]    1–50
 * @param {number} [input.width]   overall width in px, 80–4000
 * @param {number} [input.height]  overall height in px, 40–4000
 * @param {string} [input.color]   PALETTE key for the header row
 * @param {boolean}[input.headerRow]
 * @param {string} [input.title]
 * @param {string} [input.subtitle]
 * @returns {{elements: object[], width: number, height: number, columns: number, rows: number}}
 */
/**
 * Bound text element for one cell, used when a grid is rebuilt and its cells
 * already hold text (a cell with no text carries no element at all).
 */
/** Widest single word — the narrowest a wrapped line can become. */
function longestWord(text, fontSize, fontFamily) {
  let widest = 1;
  for (const word of String(text).split(/\s+/)) {
    if (!word) continue;
    widest = Math.max(widest, measure(word, fontSize, fontFamily));
  }
  return widest;
}

/**
 * Largest font size (8…20) whose longest word still fits `inner`.
 * Narrow columns get smaller text instead of glyphs spilling into the next cell.
 */
export function fitFontSize(value, inner, prefer, fontFamily = FONT_SANS) {
  let size = Math.max(8, Math.min(20, Math.round(prefer) || CELL_FONT));
  while (size > 8 && longestWord(value, size, fontFamily) * 1.15 > inner) size -= 1;
  return size;
}

/**
 * Font size and wrapped lines for a value inside a box, both dimensions considered:
 * shrink until the wrapped text is no taller than the box, and when even the
 * smallest size cannot hold the whole value, keep the lines that fit and mark the
 * cut — the untouched string stays in originalText, so editing brings it back.
 */
function fitTextToBox(value, maxWidth, maxHeight, prefer, fontFamily = FONT_SANS) {
  const floor = 7;
  let size = Math.max(floor, Math.min(20, Math.round(prefer) || CELL_FONT));
  let lines = wrap(value, maxWidth, size, fontFamily);
  while (size > floor && lines.length * size * LINE_HEIGHT > maxHeight) {
    size -= 1;
    lines = wrap(value, maxWidth, size, fontFamily);
  }
  const room = Math.max(1, Math.floor(maxHeight / (size * LINE_HEIGHT)));
  if (lines.length > room) {
    lines = lines.slice(0, room);
    const last = lines[lines.length - 1];
    lines[lines.length - 1] = last.length > 1 ? `${last.slice(0, -1)}…` : "…";
  }
  return { fontSize: size, lines };
}

export function attachCellText(cell, value, { groupIds = [], customData, id } = {}) {
  const padX = Math.min(CELL_PAD_X, Math.max(4, cell.width * 0.12));
  const innerWidth = Math.max(8, cell.width - padX * 2);
  const preferred = Math.max(8, Math.min(20, Math.round(cell.height * 0.36)));
  const fontSize = fitFontSize(value, innerWidth, preferred, FONT_SANS);
  const inner = text(cell.x + padX, cell.y + cell.height / 2 - (fontSize * LINE_HEIGHT) / 2, value, fontSize, FONT_SANS, {
    roughness: 0,
    groupIds,
    ...(id ? { id } : {}),
  });
  // text() hardcodes containerId/verticalAlign/autoResize — bind the cell by hand
  inner.containerId = cell.id;
  inner.verticalAlign = "middle";
  inner.autoResize = false;
  inner.textAlign = "left";
  inner.width = round(innerWidth);
  inner.height = round(fontSize * LINE_HEIGHT);
  if (customData) inner.customData = customData;
  cell.boundElements = [{ id: inner.id, type: "text" }];
  return inner;
}

/** Equal split, or the given sizes rescaled so they still sum to `total`. */
function fitSizes(parts, count, total, min = 1) {
  const equal = total / count;
  const usable =
    Array.isArray(parts) && parts.length === count
      ? parts.map((n) => (Number.isFinite(n) && n > 0 ? n : equal))
      : null;
  const base = usable ?? Array.from({ length: count }, () => equal);
  const sum = base.reduce((a, b) => a + b, 0);
  const sizes = (!(sum > 0) ? base.map(() => 1) : base).map((n) => (n / (sum > 0 ? sum : count)) * total);
  if (!(min > 0)) return sizes;

  // Scale proportionally, then lift every track that fell under the minimum and
  // take the difference back from the tracks that are still above it. Proportional
  // scaling alone turns a 40px column into a 12px sliver when the total shrinks.
  for (let pass = 0; pass < count; pass += 1) {
    const small = [];
    const big = [];
    sizes.forEach((size, i) => {
      if (size < min - 1e-6) small.push(i);
      else big.push(i);
    });
    if (!small.length) break;
    const deficit = small.reduce((acc, i) => acc + (min - sizes[i]), 0);
    small.forEach((i) => {
      sizes[i] = min;
    });
    if (!big.length) break;
    const room = big.reduce((acc, i) => acc + (sizes[i] - min), 0);
    if (!(room > 0)) break;
    const take = Math.min(deficit, room);
    big.forEach((i) => {
      sizes[i] -= ((sizes[i] - min) / room) * take;
    });
  }
  // rounding happens in edgesOf(); keep the sum exact here
  const drift = total - sizes.reduce((a, b) => a + b, 0);
  let widest = 0;
  sizes.forEach((size, i) => {
    if (size > sizes[widest]) widest = i;
  });
  sizes[widest] += drift;
  return sizes;
}

/** Running edge offsets: cells tile exactly, no rounding gaps between columns. */
function edgesOf(sizes) {
  const edges = [0];
  for (let i = 0; i < sizes.length; i += 1) {
    edges.push(round(edges[i] + sizes[i]));
  }
  return edges;
}

/**
 * Pad (with the average) or trim a row-height / column-width list to `count`.
 * Used when a grid is rebuilt with a different number of rows or columns.
 */
export function matchSizes(parts, count) {
  const list = Array.isArray(parts) ? parts.filter((n) => Number.isFinite(n) && n > 0) : [];
  if (!list.length || count <= 0) return [];
  if (list.length === count) return list.slice();
  if (list.length > count) return list.slice(0, count);
  const avg = list.reduce((a, b) => a + b, 0) / list.length;
  return [...list, ...Array.from({ length: count - list.length }, () => avg)];
}

/* -------------------------------------------------------- grid cell / frame */

/**
 * True only for a live cell of a grid. The transparent table frame shares the
 * grid's customData but carries no row/column slot, so geometry, resize and
 * selection code must never count it as a cell.
 */
export function isGridCell(el, gridId) {
  if (!el || el.type !== "rectangle" || el.isDeleted) return false;
  const cd = el.customData;
  if (!cd || !cd.grid) return false;
  if (gridId != null && cd.grid !== gridId) return false;
  return Number.isFinite(cd.r) && Number.isFinite(cd.c);
}

/** True only for a live table frame — the invisible rectangle arrows bind to. */
export function isGridFrame(el, gridId) {
  if (!el || el.type !== "rectangle" || el.isDeleted) return false;
  const cd = el.customData;
  if (!cd || cd.frame !== true) return false;
  return gridId == null || cd.grid === gridId;
}

/** A fresh grid id, shaped like the ones buildGrid mints on its own. */
export function newGridId() {
  return nextId("grid");
}

/** Copy of `el` with `patch` applied and its version bumped (change detection). */
export function bumpElement(el, patch) {
  return {
    ...el,
    ...patch,
    version: (el.version || 0) + 1,
    versionNonce: randInt(2 ** 31),
    updated: Date.now(),
  };
}

/**
 * Visual bounds of one table: every live cell plus its title/subtitle texts.
 * Frames are ignored — otherwise a stale frame would feed its own size back in.
 * Returns null when the grid has no live cell.
 */
export function tableBounds(elements, gridId) {
  const list = elements || [];
  const cells = list.filter((el) => isGridCell(el, gridId));
  if (!cells.length) {
    // A UML class preset has no cells; its visible frame is the node bounds
    // that hover handles and connector bindings use.
    const frame = list.find(
      (el) => isGridFrame(el, gridId) && el.customData?.class === true,
    );
    if (!frame) return null;
    return {
      left: round(frame.x),
      top: round(frame.y),
      right: round(frame.x + frame.width),
      bottom: round(frame.y + frame.height),
      width: round(frame.width),
      height: round(frame.height),
      centerX: round(frame.x + frame.width / 2),
      centerY: round(frame.y + frame.height / 2),
    };
  }
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const el of cells) {
    left = Math.min(left, el.x);
    top = Math.min(top, el.y);
    right = Math.max(right, el.x + el.width);
    bottom = Math.max(bottom, el.y + el.height);
  }
  for (const el of list) {
    if (el.type !== "text" || el.isDeleted) continue;
    const cd = el.customData;
    if (!cd || cd.grid !== gridId || (!cd.title && !cd.subtitle)) continue;
    left = Math.min(left, el.x);
    top = Math.min(top, el.y);
    right = Math.max(right, el.x + el.width);
    bottom = Math.max(bottom, el.y + el.height);
  }
  return {
    left: round(left),
    top: round(top),
    right: round(right),
    bottom: round(bottom),
    width: round(right - left),
    height: round(bottom - top),
    centerX: round((left + right) / 2),
    centerY: round((top + bottom) / 2),
  };
}

/**
 * Keep one table's frame on its bounds. Returns a new element array, or null when
 * nothing changed. `create` inserts the frame before the grid's first element so
 * it stays behind the cells; without it a missing frame is left alone (old boards
 * are migrated lazily, when a relation needs them, not on load).
 */
export function ensureGridFrame(elements, gridId, { create = false } = {}) {
  const list = elements || [];
  const bounds = tableBounds(list, gridId);
  if (!bounds) return null;

  // look at deleted elements too: the heal pass sees the scene including
  // tombstones, and a deleted frame must be reused under its own id instead of
  // being duplicated when its cells are still alive
  const existing = list.find(
    (el) => el.type === "rectangle" && el.customData?.frame === true && el.customData?.grid === gridId,
  );
  if (existing) {
    const patch = {};
    if (existing.isDeleted) patch.isDeleted = false;
    if (Math.abs(existing.x - bounds.left) > 0.5) patch.x = bounds.left;
    if (Math.abs(existing.y - bounds.top) > 0.5) patch.y = bounds.top;
    if (Math.abs(existing.width - bounds.width) > 0.5) patch.width = bounds.width;
    if (Math.abs(existing.height - bounds.height) > 0.5) patch.height = bounds.height;
    if (!Object.keys(patch).length) return null;
    return list.map((el) => (el === existing ? bumpElement(existing, patch) : el));
  }

  if (!create) return null;

  const frame = {
    ...base("rectangle", bounds.left, bounds.top, bounds.width, bounds.height, {
      id: `${gridId}-frame`,
      strokeColor: "transparent",
      backgroundColor: "transparent",
      strokeWidth: 1,
      roughness: 0,
      groupIds: [`g${gridId}`],
    }),
    updated: Date.now(),
    customData: { grid: gridId, frame: true },
  };
  const at = list.findIndex((el) => el.customData?.grid === gridId);
  const out = list.slice();
  out.splice(at < 0 ? list.length : at, 0, frame);
  return out;
}

export function buildGrid({
  columns = 3,
  rows = 4,
  width = 520,
  height = 220,
  color = "blue",
  headerRow = true,
  title,
  subtitle,
  gridId,
  idPrefix,
  colWidths,
  rowHeights,
} = {}) {
  const gid = gridId ?? nextId("grid");
  const meta = { grid: gid, color, headerRow };
  // one group for the whole grid: single click selects / drags the table as a unit
  const groupId = `g${gid}`;
  // A rebuild of an existing grid can pin element ids to the grid id + slot, so
  // the same cell keeps the same id when its size or position changes. Undo then
  // moves cells around instead of swapping in a second generation of cells.
  const pin = typeof idPrefix === "string" && idPrefix ? idPrefix : "";
  const idFor = pin ? (key) => `${pin}-${key}` : () => nextId("rect"[0]);
  const cols = clampInt(columns, 1, 20, 3);
  const lines = clampInt(rows, 1, 50, 4);
  // a track never goes below its minimum: a 9-column table cannot be 200px wide,
  // it grows to 9 x 40 instead of turning every column into an unreadable sliver
  const cardW = clampInt(Math.max(width, cols * GRID_MIN_COL_W), 80, 4000, 520);
  const cardH = clampInt(Math.max(height, lines * GRID_MIN_ROW_H), 40, 4000, 220);
  const palette = PALETTE[color] ?? PALETTE.gray;

  const titleText = title ? String(title).trim() : "";
  const subtitleText = subtitle ? String(subtitle).trim() : "";
  const titleH =
    (titleText ? TITLE_FONT * LINE_HEIGHT : 0) +
    (subtitleText ? SUBTITLE_FONT * LINE_HEIGHT + 2 : 0) +
    (titleText || subtitleText ? TITLE_GAP : 0);

  const elements = [];
  // The frame is the first element of every grid: it is the anchor relation
  // arrows bind to, and sitting below title/cells keeps it from swallowing
  // clicks meant for a cell. Its width also covers a title wider than the table.
  const frameWidth = Math.max(
    cardW,
    titleText ? measure(titleText, TITLE_FONT, FONT_SANS) : 0,
    subtitleText ? measure(subtitleText, SUBTITLE_FONT, FONT_SANS) : 0,
  );
  const frame = {
    ...rect(0, 0, frameWidth, titleH + cardH, {
      id: `${gid}-frame`,
      strokeColor: "transparent",
      backgroundColor: "transparent",
      strokeWidth: 1,
      roughness: 0,
      groupIds: [groupId],
    }),
    customData: { grid: gid, frame: true },
  };
  elements.push(frame);
  if (titleText) {
    const head = text(0, 0, titleText, TITLE_FONT, FONT_SANS, {
      roughness: 0,
      groupIds: [groupId],
      ...(pin ? { id: idFor("title") } : {}),
    });
    head.customData = { grid: gid, title: true };
    elements.push(head);
  }
  if (subtitleText) {
    const sub = text(0, titleText ? TITLE_FONT * LINE_HEIGHT : 0, subtitleText, SUBTITLE_FONT, FONT_SANS, {
      strokeColor: MUTED,
      roughness: 0,
      groupIds: [groupId],
      ...(pin ? { id: idFor("sub") } : {}),
    });
    sub.customData = { grid: gid, subtitle: true };
    elements.push(sub);
  }

  // sizes are optional: without them the grid is uniform, with them the shape
  // the user dragged out earlier survives a rebuild
  const colEdges = edgesOf(fitSizes(colWidths, cols, cardW, GRID_MIN_COL_W));
  const rowEdges = edgesOf(fitSizes(rowHeights, lines, cardH, GRID_MIN_ROW_H));

  for (let r = 0; r < lines; r += 1) {
    const header = headerRow && r === 0;
    for (let c = 0; c < cols; c += 1) {
      const x = colEdges[c];
      const y = titleH + rowEdges[r];
      const cell = rect(x, y, colEdges[c + 1] - colEdges[c], rowEdges[r + 1] - rowEdges[r], {
        strokeColor: header ? palette.stroke : RULE,
        backgroundColor: header ? palette.fill : "#ffffff",
        roughness: 0,
        strokeWidth: 1,
        groupIds: [groupId],
        ...(pin ? { id: idFor(`r${r}c${c}`) } : {}),
      });
      // cw/rh are the sizes this cell is *meant* to have: Excalidraw may grow a
      // container to fit its text, and a table with one column has no sibling to
      // compare against, so each cell remembers the tiling it was built with.
      cell.customData = { ...meta, rows: lines, cols, r, c, cw: cell.width, rh: cell.height };
      elements.push(cell);
    }
  }

  return { elements, width: cardW, height: titleH + cardH, columns: cols, rows: lines, frameId: frame.id };
}

/* ------------------------------------------------------------ grid geometry */

const GRID_MIN_ROW_H = 24;
const GRID_MAX_ROW_H = 1200;
const GRID_MIN_COL_W = 40;
const GRID_MAX_COL_W = 1600;

/**
 * Cells built by this module remember the row height and column width they were
 * created (or resized) with, so a single-cell table can be put back on its
 * tiling even though it has no sibling to compare against.
 */
function remembersSize(cell) {
  return Number(cell.customData?.rh) > 0 && Number(cell.customData?.cw) > 0;
}

/**
 * The value a majority of `values` agree on (rounded to 0.01); the median when
 * nothing has a majority. One mutant cell must not win against its siblings.
 */
function consensus(values) {
  const counts = new Map();
  for (const value of values) {
    const key = Math.round(value * 100) / 100;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  let best = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  const winners = [...counts].filter(([, count]) => count === bestCount);
  return winners.length === 1 ? best : median;
}

/**
 * Snap the cells of one grid back onto the tiling their siblings describe.
 *
 * Excalidraw grows a container when its bound text does not fit
 * (`redrawTextBoundingBox` in excalidraw: `if (metrics.height > maxContainerHeight)
 * mutateElement(container, { height: nextHeight })`), so typing a long value into
 * a narrow cell inflates that one cell and its row stops lining up with the rest.
 * Our table is the authority — a single cell growing is never intended — so the
 * deviating cell is put back on the row/column edges the other cells agree on.
 *
 * Returns the repaired element array, or null when the grid already lines up.
 */
export function snapGridTracks(elements, gridId) {
  const cells = gridCells(elements, gridId);
  if (cells.length < 2 && !cells.every(remembersSize)) return null;

  const rows = new Map();
  const cols = new Map();
  for (const cell of cells) {
    const { r, c } = cell.customData;
    if (!rows.has(r)) rows.set(r, []);
    if (!cols.has(c)) cols.set(c, []);
    rows.get(r).push(cell);
    cols.get(c).push(cell);
  }

  // A track keeps what its cells were built with (or resized to by the sliders);
  // only cells from older scenes, which carry no memory, fall back to agreement.
  const trackSize = (group, key, measured) => {
    const intent = group.map((cell) => Number(cell.customData?.[key]));
    if (intent.length === group.length && intent.every((n) => Number.isFinite(n) && n > 0)) {
      return consensus(intent);
    }
    return consensus(group.map((cell) => measured(cell)));
  };

  const top = Math.min(...cells.map((cell) => cell.y));
  const left = Math.min(...cells.map((cell) => cell.x));
  const rowTop = new Map();
  const rowHeight = new Map();
  let cursor = top;
  for (const r of [...rows.keys()].sort((a, b) => a - b)) {
    const height = trackSize(rows.get(r), "rh", (cell) => cell.height);
    rowTop.set(r, cursor);
    rowHeight.set(r, height);
    cursor += height;
  }
  const colLeft = new Map();
  const colWidth = new Map();
  cursor = left;
  for (const c of [...cols.keys()].sort((a, b) => a - b)) {
    const width = trackSize(cols.get(c), "cw", (cell) => cell.width);
    colLeft.set(c, cursor);
    colWidth.set(c, width);
    cursor += width;
  }

  let changed = false;
  const out = (elements || []).map((el) => {
    if (!isGridCell(el, gridId)) return el;
    const { r, c } = el.customData;
    const geometry = { x: colLeft.get(c), y: rowTop.get(r), width: colWidth.get(c), height: rowHeight.get(r) };
    if (
      Math.abs(el.x - geometry.x) < 0.5 &&
      Math.abs(el.y - geometry.y) < 0.5 &&
      Math.abs(el.width - geometry.width) < 0.5 &&
      Math.abs(el.height - geometry.height) < 0.5
    ) {
      return el;
    }
    changed = true;
    return { ...el, ...geometry };
  });
  return changed ? out : null;
}

/**
 * Re-wrap / shrink the bound texts of one grid so each one stays inside its cell.
 * Typing into Excalidraw grows the text to whatever the editor used, which spills
 * out of a narrow or short cell; returns null when everything already fits.
 */
export function fitCellTexts(elements, gridId) {
  const cells = gridCells(elements, gridId);
  if (!cells.length) return null;
  const box = new Map(cells.map((cell) => [cell.id, cell]));
  let changed = false;
  const out = (elements || []).map((el) => {
    if (el.type !== "text" || el.isDeleted || !el.containerId) return el;
    const cell = box.get(el.containerId);
    if (!cell) return el;
    const spills =
      el.x < cell.x - 0.5 ||
      el.y < cell.y - 0.5 ||
      el.x + el.width > cell.x + cell.width + 0.5 ||
      el.y + el.height > cell.y + cell.height + 0.5;
    if (!spills) return el;
    const next = refitCellText(el, cell, true);
    if (
      next.text !== el.text ||
      next.fontSize !== el.fontSize ||
      next.x !== el.x ||
      next.y !== el.y ||
      next.width !== el.width ||
      next.height !== el.height
    ) {
      changed = true;
      return next;
    }
    return el;
  });
  return changed ? out : null;
}

/**
 * Bring a grid back to a consistent shape after anything touched it: first put
 * every cell back on the tiling (a cell that Excalidraw grew for its text must
 * not be allowed to warp its row), then shrink the texts into the restored
 * boxes. Returns null when the grid was already consistent.
 */
export function healGrid(elements, gridId) {
  const snapped = snapGridTracks(elements, gridId) ?? elements;
  const fitted = fitCellTexts(snapped, gridId) ?? snapped;
  // an existing frame follows the new bounds; a missing one is not created here
  // (old boards migrate lazily, when a relation needs their frame)
  const framed = ensureGridFrame(fitted, gridId, { create: false }) ?? fitted;
  return framed === elements ? null : framed;
}

/** Rectangle cells of one grid, deleted ones excluded; the frame is not a cell. */
function gridCells(elements, gridId) {
  return (elements || []).filter((el) => isGridCell(el, gridId));
}

/**
 * Row heights / column widths of a grid, derived from the cells themselves:
 * the grid carries no size metadata, so its geometry is the only truth — and a
 * table the user resized by hand still reports real numbers.
 */
export function gridMetrics(elements, gridId) {
  const cells = gridCells(elements, gridId);
  if (!cells.length) return null;
  const rowTop = new Map();
  const rowBottom = new Map();
  const colLeft = new Map();
  const colRight = new Map();
  for (const cell of cells) {
    const r = cell.customData.r | 0;
    const c = cell.customData.c | 0;
    rowTop.set(r, Math.min(rowTop.get(r) ?? Infinity, cell.y));
    rowBottom.set(r, Math.max(rowBottom.get(r) ?? -Infinity, cell.y + cell.height));
    colLeft.set(c, Math.min(colLeft.get(c) ?? Infinity, cell.x));
    colRight.set(c, Math.max(colRight.get(c) ?? -Infinity, cell.x + cell.width));
  }
  const rows = [...rowTop.keys()]
    .sort((a, b) => a - b)
    .map((r) => ({ r, top: round(rowTop.get(r)), height: round(rowBottom.get(r) - rowTop.get(r)) }));
  const cols = [...colLeft.keys()]
    .sort((a, b) => a - b)
    .map((c) => ({ c, left: round(colLeft.get(c)), width: round(colRight.get(c) - colLeft.get(c)) }));
  const left = cols.length ? cols[0].left : 0;
  const top = rows.length ? rows[0].top : 0;
  const right = cols.length ? cols[cols.length - 1].left + cols[cols.length - 1].width : 0;
  const bottom = rows.length ? rows[rows.length - 1].top + rows[rows.length - 1].height : 0;
  return {
    rows,
    cols,
    bounds: { left, top, right, bottom, width: round(right - left), height: round(bottom - top) },
  };
}

/** Cell text after its cell moved or changed width: rewrapped and centred. */
function refitCellText(el, box, rewrap) {
  const family = el.fontFamily ?? FONT_SANS;
  const padX = Math.min(CELL_PAD_X, Math.max(4, box.width * 0.12));
  const maxWidth = Math.max(8, box.width - padX * 2);
  const source = el.originalText ?? el.text ?? "";
  let fontSize = el.fontSize || CELL_FONT;
  let width = el.width;
  let height = el.height;
  let value = el.text;
  if (rewrap) {
    // the preferred size follows the cell height, so widening a column grows the text back
    const preferred = Math.max(8, Math.min(20, Math.round(box.height * 0.36)));
    const fitted = fitTextToBox(source, maxWidth, Math.max(8, box.height), preferred, family);
    fontSize = fitted.fontSize;
    const lines = fitted.lines;
    const widest = Math.max(...lines.map((line) => measure(line, fontSize, family)), 1);
    width = round(Math.min(maxWidth, widest));
    height = round(lines.length * fontSize * LINE_HEIGHT);
    value = lines.join("\n");
  }
  return {
    ...el,
    x: round(box.x + (box.width - width) / 2),
    y: round(box.y + (box.height - height) / 2),
    width: round(width),
    height: round(height),
    text: value,
    fontSize,
  };
}

function resizeTrack(elements, gridId, { axis, index, size, min, max, rewrap = true }) {
  const rowsMode = axis === "row";
  const metrics = gridMetrics(elements, gridId);
  const track = metrics ? (rowsMode ? metrics.rows : metrics.cols) : [];
  const current = track.find((t) => (rowsMode ? t.r : t.c) === index);
  if (!current) return { elements, changed: 0, size: null, previous: null };

  const previous = rowsMode ? current.height : current.width;
  const wanted = Number(size);
  const next = round(
    Math.max(min, Math.min(max, Number.isFinite(wanted) && wanted > 0 ? wanted : previous)),
  );
  if (Math.abs(next - previous) < 0.5) return { elements, changed: 0, size: previous, previous };

  const delta = round(next - previous);
  const cells = gridCells(elements, gridId);
  const boxes = new Map();
  for (const cell of cells) {
    const at = (rowsMode ? cell.customData.r : cell.customData.c) | 0;
    const box = { x: cell.x, y: cell.y, width: cell.width, height: cell.height };
    if (at === index) {
      if (rowsMode) box.height = next;
      else box.width = next;
    } else if (at > index) {
      if (rowsMode) box.y = cell.y + delta;
      else box.x = cell.x + delta;
    }
    if (box.x !== cell.x || box.y !== cell.y || box.width !== cell.width || box.height !== cell.height) {
      boxes.set(cell.id, box);
    }
  }
  if (!boxes.size) return { elements, changed: 0, size: previous, previous };

  const cellById = new Map(cells.map((el) => [el.id, el]));
  const now = Date.now();
  let changed = 0;
  const out = (elements || []).map((el) => {
    const box = boxes.get(el.id);
    if (box) {
      changed += 1;
      // the track that was resized remembers its new size; a shifted cell keeps its own
      const moved = box.width !== el.width ? { cw: box.width } : box.height !== el.height ? { rh: box.height } : null;
      return {
        ...el,
        ...box,
        ...(moved && el.customData ? { customData: { ...el.customData, ...moved } } : {}),
        version: (el.version || 1) + 1,
        versionNonce: randInt(1e9),
        updated: now,
      };
    }
    if (!el.isDeleted && el.type === "text" && el.containerId && boxes.has(el.containerId)) {
      const cell = cellById.get(el.containerId);
      const nextBox = boxes.get(el.containerId);
      const patched = refitCellText(el, nextBox, rewrap && !rowsMode && nextBox.width !== cell.width);
      changed += 1;
      return { ...patched, version: (el.version || 1) + 1, versionNonce: randInt(1e9), updated: now };
    }
    return el;
  });
  return { elements: out, changed, size: next, previous };
}

/**
 * Grow/shrink one row: rows below shift, that row's text stays centred.
 * `rewrap: false` skips the text measuring pass — used for live previews, where
 * only the final size needs properly rewrapped text.
 */
export function resizeGridRow(elements, gridId, r, height, { rewrap = true } = {}) {
  return resizeTrack(elements, gridId, {
    axis: "row",
    index: Number(r) | 0,
    size: height,
    min: GRID_MIN_ROW_H,
    max: GRID_MAX_ROW_H,
    rewrap,
  });
}

/** Grow/shrink one column: columns to the right shift, text rewraps. */
export function resizeGridColumn(elements, gridId, c, width, { rewrap = true } = {}) {
  return resizeTrack(elements, gridId, {
    axis: "col",
    index: Number(c) | 0,
    size: width,
    min: GRID_MIN_COL_W,
    max: GRID_MAX_COL_W,
    rewrap,
  });
}

export { PALETTE };
export { rect as makeRect, line as makeLine, text as makeText, measure as measureText };
