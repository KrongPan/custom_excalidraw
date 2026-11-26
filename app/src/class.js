/* --------------------------------------------------------------- UML class */
/**
 * The "UML class" preset: one box with a title, a fields section and a methods
 * section, a +/- collapse control, and a visible frame that relation arrows
 * bind to. Fields and methods are separate text elements, so each line can be
 * edited on its own; classData on the frame is the source of truth when the box
 * is collapsed.
 */
import {
  bumpElement,
  fitFontSize,
  isGridFrame,
  makeLine,
  makeRect,
  makeText,
  measureText,
  newGridId,
} from "./table.js";

const FONT = 2;
const TITLE_FONT = 16;
const LINE_FONT = 13;
const LINE_HEIGHT = 1.25;
const HEADER_H = 44;
const LINE_H = 28;
const PAD_X = 16;
const PAD_TOP = 8;
const MIN_WIDTH = 180;
const MAX_WIDTH = 900;
const DEFAULT_WIDTH = 320;
const INK = "#1e1e1e";
const RULE = "#1e1e1e";
const TOGGLE_BG = "#e9ecef";
const TOGGLE_STROKE = "#868e96";

const round = (n) => Math.round(n * 100) / 100;

function clampWidth(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_WIDTH;
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, n));
}

function linesOf(value) {
  if (Array.isArray(value)) return value.map((line) => String(line ?? ""));
  return String(value ?? "").split(/\r?\n/);
}

function sectionHeight(lines) {
  return Math.max(1, lines.length) * LINE_H + PAD_TOP * 2;
}

function findClassFrame(elements, gridId) {
  return (elements || []).find(
    (el) => isGridFrame(el, gridId) && el.customData?.class === true,
  );
}

/** True when this grid id is the UML class preset (not a cell grid). */
export function isClassGrid(elements, gridId) {
  return Boolean(findClassFrame(elements, gridId));
}

function classText(elements, gridId, key) {
  return (elements || []).find(
    (el) => el.type === "text" && !el.isDeleted && el.customData?.grid === gridId && el.customData?.[key],
  );
}

function classLines(elements, gridId, section, count) {
  const out = Array.from({ length: count }, () => "");
  for (const el of elements || []) {
    if (el.type !== "text" || el.isDeleted || el.customData?.grid !== gridId) continue;
    if (el.customData?.classLine !== section) continue;
    const index = Number(el.customData.index);
    if (!Number.isInteger(index) || index < 0) continue;
    out[index] = el.text ?? "";
  }
  return out;
}

/** Current class data, read from the live text lines (or classData when collapsed). */
export function readClassSpec(elements, gridId) {
  const frame = findClassFrame(elements, gridId);
  if (!frame) return null;
  const data = frame.customData?.classData ?? {};
  const titleEl = classText(elements, gridId, "classTitle");
  const title = (titleEl?.text ?? data.title ?? "Classname").trim() || "Classname";
  const collapsed = data.collapsed === true;
  if (collapsed) {
    return {
      grid: gridId,
      kind: "class",
      title,
      fields: linesOf(data.fields ?? []),
      methods: linesOf(data.methods ?? []),
      width: frame.width,
      collapsed: true,
      height: frame.height,
    };
  }
  const fields = classLines(elements, gridId, "fields", (data.fields ?? []).length);
  const methods = classLines(elements, gridId, "methods", (data.methods ?? []).length);
  return {
    grid: gridId,
    kind: "class",
    title,
    fields,
    methods,
    width: frame.width,
    collapsed: false,
    height: frame.height,
  };
}

/** Description used by the side panel. */
export function describeClass(elements, gridId) {
  return readClassSpec(elements, gridId);
}

/** Build a fresh class node at its own local origin (0,0). */
export function buildClass({
  gridId,
  title = "Classname",
  fields = [],
  methods = [],
  width = DEFAULT_WIDTH,
  collapsed = false,
} = {}) {
  const gid = gridId ?? newGridId();
  const groupId = `g${gid}`;
  const w = clampWidth(width);
  const fieldLines = linesOf(fields);
  const methodLines = linesOf(methods);
  const classTitle = String(title ?? "").trim() || "Classname";
  const fieldsH = sectionHeight(fieldLines);
  const methodsH = sectionHeight(methodLines);
  const h = collapsed ? HEADER_H : HEADER_H + fieldsH + methodsH;
  const elements = [];

  const frame = makeRect(0, 0, w, h, {
    id: `${gid}-frame`,
    strokeColor: INK,
    backgroundColor: "#ffffff",
    strokeWidth: 1.5,
    roughness: 0,
    groupIds: [groupId],
  });
  frame.customData = {
    grid: gid,
    frame: true,
    class: true,
    classData: {
      title: classTitle,
      fields: fieldLines,
      methods: methodLines,
      width: w,
      collapsed,
    },
  };
  elements.push(frame);

  const titleFont = fitFontSize(classTitle, w - PAD_X * 2, TITLE_FONT, FONT);
  const titleEl = makeText(0, 0, classTitle, titleFont, FONT, {
    id: `${gid}-title`,
    groupIds: [groupId],
    roughness: 0,
    color: INK,
  });
  titleEl.x = round((w - titleEl.width) / 2);
  titleEl.y = round((HEADER_H - titleEl.height) / 2);
  titleEl.customData = { grid: gid, classTitle: true };
  elements.push(titleEl);

  if (!collapsed) {
    const sepHead = makeLine(0, HEADER_H, w, {
      id: `${gid}-sep-head`,
      groupIds: [groupId],
      strokeColor: RULE,
      strokeWidth: 1,
      roughness: 0,
    });
    sepHead.customData = { grid: gid, classSep: true };
    elements.push(sepHead);

    fieldLines.forEach((value, index) => {
      if (!value) return;
      const fontSize = fitFontSize(value, w - PAD_X * 2, LINE_FONT, FONT);
      const el = makeText(PAD_X, 0, value, fontSize, FONT, {
        id: `${gid}-field-${index}`,
        groupIds: [groupId],
        roughness: 0,
        color: INK,
      });
      el.y = round(HEADER_H + PAD_TOP + index * LINE_H + (LINE_H - el.height) / 2);
      el.customData = { grid: gid, classLine: "fields", index };
      elements.push(el);
    });

    const sepFields = makeLine(0, HEADER_H + fieldsH, w, {
      id: `${gid}-sep-fields`,
      groupIds: [groupId],
      strokeColor: RULE,
      strokeWidth: 1,
      roughness: 0,
    });
    sepFields.customData = { grid: gid, classSep: true };
    elements.push(sepFields);

    methodLines.forEach((value, index) => {
      if (!value) return;
      const fontSize = fitFontSize(value, w - PAD_X * 2, LINE_FONT, FONT);
      const el = makeText(PAD_X, 0, value, fontSize, FONT, {
        id: `${gid}-method-${index}`,
        groupIds: [groupId],
        roughness: 0,
        color: INK,
      });
      el.y = round(
        HEADER_H + fieldsH + PAD_TOP + index * LINE_H + (LINE_H - el.height) / 2,
      );
      el.customData = { grid: gid, classLine: "methods", index };
      elements.push(el);
    });
  }

  const toggle = makeRect(8, 8, 16, 16, {
    id: `${gid}-toggle`,
    strokeColor: TOGGLE_STROKE,
    backgroundColor: TOGGLE_BG,
    strokeWidth: 1,
    roughness: 0,
    roundness: { type: 3 },
    groupIds: [groupId],
  });
  toggle.customData = { grid: gid, classToggle: true };
  elements.push(toggle);

  const symbol = collapsed ? "+" : "−";
  const toggleText = makeText(0, 0, symbol, 14, FONT, {
    id: `${gid}-toggle-t`,
    groupIds: [groupId],
    roughness: 0,
    color: INK,
  });
  toggleText.x = round(8 + (16 - toggleText.width) / 2);
  toggleText.y = round(8 + (16 - toggleText.height) / 2);
  toggleText.customData = { grid: gid, classToggle: true };
  elements.push(toggleText);

  return {
    elements,
    gridId: gid,
    frameId: `${gid}-frame`,
    width: w,
    height: h,
    collapsed,
    kind: "class",
  };
}

function replaceBlock(elements, gridId, block) {
  const at = elements.findIndex((el) => el.customData?.grid === gridId);
  const out = [];
  let inserted = false;
  for (const el of elements) {
    if (el.customData?.grid === gridId) {
      if (!inserted) {
        out.push(...block);
        inserted = true;
      }
      continue;
    }
    out.push(el);
  }
  if (!inserted) {
    const index = at < 0 ? elements.length : Math.min(at, out.length);
    out.splice(index, 0, ...block);
  }
  return out;
}

/** Rebuild a class from a spec, keeping its top-left scene position. */
export function updateClass(elements, gridId, spec = {}) {
  const frame = findClassFrame(elements, gridId);
  if (!frame) return null;
  const current = readClassSpec(elements, gridId);
  const built = buildClass({
    ...current,
    ...spec,
    gridId,
    width: spec.width ?? current.width,
    collapsed: spec.collapsed ?? current.collapsed,
  });
  const originX = frame.x;
  const originY = frame.y;
  const placed = built.elements.map((el) => ({
    ...el,
    x: round(el.x + originX),
    y: round(el.y + originY),
  }));
  return {
    elements: replaceBlock(elements, gridId, placed),
    count: placed.length,
    frameId: built.frameId,
  };
}

/** Collapse to the title bar, or expand the stored fields/methods again. */
export function toggleClass(elements, gridId) {
  const current = readClassSpec(elements, gridId);
  if (!current) return null;
  return updateClass(elements, gridId, {
    ...current,
    collapsed: !current.collapsed,
  });
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Keep an expanded class laid out after a line/title edit: re-fit the text,
 * move the section rules and the frame height. Returns a new array or null.
 */
export function healClass(elements, gridId) {
  const frame = findClassFrame(elements, gridId);
  if (!frame) return null;
  const current = readClassSpec(elements, gridId);
  if (!current) return null;
  const w = frame.width;
  const letter = {};

  if (current.collapsed) {
    const nextData = {
      ...(frame.customData?.classData ?? {}),
      title: current.title,
      fields: current.fields,
      methods: current.methods,
      width: w,
      collapsed: true,
    };
    if (frame.height !== HEADER_H) letter[frame.id] = bumpElement(frame, { height: HEADER_H });
    if (!same(frame.customData?.classData, nextData)) {
      letter[frame.id] = bumpElement(letter[frame.id] ?? frame, {
        customData: { ...frame.customData, classData: nextData },
      });
    }
    const titleEl = classText(elements, gridId, "classTitle");
    if (titleEl) {
      const fontSize = fitFontSize(current.title, w - PAD_X * 2, TITLE_FONT, FONT);
      const width = round(measureText(current.title, fontSize, FONT));
      const textHeight = round(fontSize * LINE_HEIGHT);
      const patch = {
        text: current.title,
        originalText: current.title,
        fontSize,
        width,
        height: textHeight,
        x: round((w - width) / 2),
        y: round((HEADER_H - textHeight) / 2),
      };
      const changed = Object.entries(patch).some(([key, value]) => !same(titleEl[key], value));
      if (changed) letter[titleEl.id] = bumpElement(titleEl, patch);
    }
    return Object.keys(letter).length ? elements.map((el) => letter[el.id] ?? el) : null;
  }

  const fieldsH = sectionHeight(current.fields);
  const methodsH = sectionHeight(current.methods);
  const height = HEADER_H + fieldsH + methodsH;
  const nextData = {
    ...(frame.customData?.classData ?? {}),
    title: current.title,
    fields: current.fields,
    methods: current.methods,
    width: w,
    collapsed: false,
  };

  if (frame.height !== height) {
    letter[frame.id] = bumpElement(frame, { height });
  }
  if (!same(frame.customData?.classData, nextData)) {
    const baseEl = letter[frame.id] ?? frame;
    letter[frame.id] = bumpElement(baseEl, {
      customData: { ...baseEl.customData, classData: nextData },
    });
  }

  const bumpText = (el, patch) => {
    if (!el) return;
    const changed = Object.entries(patch).some(([key, value]) => !same(el[key], value));
    if (!changed) return;
    letter[el.id] = bumpElement(el, patch);
  };

  const titleEl = classText(elements, gridId, "classTitle");
  if (titleEl) {
    const fontSize = fitFontSize(current.title, w - PAD_X * 2, TITLE_FONT, FONT);
    const width = round(measureText(current.title, fontSize, FONT));
    const textHeight = round(fontSize * LINE_HEIGHT);
    bumpText(titleEl, {
      text: current.title,
      originalText: current.title,
      fontSize,
      width,
      height: textHeight,
      x: round((w - width) / 2),
      y: round((HEADER_H - textHeight) / 2),
    });
  }

  const setLine = (el, value, y) => {
    if (!el) return;
    const clean = String(value ?? "").replace(/\s*\n\s*/g, " ");
    const fontSize = fitFontSize(clean, w - PAD_X * 2, LINE_FONT, FONT);
    const width = round(measureText(clean, fontSize, FONT));
    const textHeight = round(fontSize * LINE_HEIGHT);
    bumpText(el, {
      text: clean,
      originalText: clean,
      fontSize,
      width,
      height: textHeight,
      x: PAD_X,
      y: round(y + (LINE_H - textHeight) / 2),
    });
  };

  for (const el of elements) {
    if (el.type !== "text" || el.isDeleted || el.customData?.grid !== gridId) continue;
    if (el.customData?.classLine === "fields") {
      const index = Number(el.customData.index) | 0;
      setLine(el, current.fields[index] ?? "", HEADER_H + PAD_TOP + index * LINE_H);
    } else if (el.customData?.classLine === "methods") {
      const index = Number(el.customData.index) | 0;
      setLine(
        el,
        current.methods[index] ?? "",
        HEADER_H + fieldsH + PAD_TOP + index * LINE_H,
      );
    }
  }

  for (const el of elements) {
    if (el.type !== "line" || el.isDeleted || el.customData?.grid !== gridId) continue;
    if (el.id === `${gridId}-sep-head`) {
      if (el.x !== 0 || el.y !== HEADER_H || el.width !== w) {
        letter[el.id] = bumpElement(el, { x: 0, y: HEADER_H, width: w });
      }
    } else if (el.id === `${gridId}-sep-fields`) {
      const y = HEADER_H + fieldsH;
      if (el.x !== 0 || el.y !== y || el.width !== w) {
        letter[el.id] = bumpElement(el, { x: 0, y, width: w });
      }
    }
  }

  const toggle = elements.find(
    (el) => !el.isDeleted && el.customData?.grid === gridId && el.customData?.classToggle && el.type === "rectangle",
  );
  if (toggle) {
    if (toggle.x !== 8 || toggle.y !== 8) {
      letter[toggle.id] = bumpElement(toggle, { x: 8, y: 8 });
    }
  }

  return Object.keys(letter).length ? elements.map((el) => letter[el.id] ?? el) : null;
}
