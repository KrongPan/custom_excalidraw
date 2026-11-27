import { useEffect, useState } from "react";

const COLORS = ["gray", "blue", "green", "yellow", "orange", "red", "violet", "cyan"];

const LIMITS = {
  columns: [1, 20],
  rows: [1, 50],
  width: [80, 4000],
  height: [40, 4000],
};

function clamp(value, [lo, hi], fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

function NumberField({ label, value, limits, fallback, step = 1, onChange }) {
  return (
    <label>
      {label}
      <input
        type="number"
        aria-label={label}
        min={limits[0]}
        max={limits[1]}
        step={step}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => onChange(clamp(value, limits, fallback))}
      />
    </label>
  );
}

export default function TableBuilder({ open, onClose, onInsert, selected, onUpdate }) {
  const [title, setTitle] = useState("");
  const [columns, setColumns] = useState(3);
  const [rows, setRows] = useState(4);
  const [width, setWidth] = useState(520);
  const [height, setHeight] = useState(240);
  const [color, setColor] = useState("blue");
  const [headerRow, setHeaderRow] = useState(true);
  const [note, setNote] = useState(null);

  // when a cell of an existing grid is selected, mirror it into the form: the
  // update button sends every field, so a stale heading would wipe the real one
  useEffect(() => {
    if (!open || !selected) return;
    setColumns(selected.cols);
    setRows(selected.rows);
    if (selected.width) setWidth(selected.width);
    if (selected.height) setHeight(selected.height);
    setTitle(selected.title ?? "");
  }, [open, selected?.grid, selected?.cols, selected?.rows, selected?.width, selected?.height, selected?.title]);

  const cellW = Math.max(1, Math.round(width / Math.max(1, columns)));
  const cellH = Math.max(1, Math.round(height / Math.max(1, rows)));

  const run = (fn, label) => {
    try {
      const count = fn();
      setNote({ ok: true, text: `${label} · ${count} elements` });
    } catch (error) {
      setNote({ ok: false, text: error?.message || String(error) });
    }
  };

  const insert = () => {
    try {
      const count = onInsert({
        title: String(title).trim() || undefined,
        color,
        headerRow,
        columns: clamp(columns, LIMITS.columns, 3),
        rows: clamp(rows, LIMITS.rows, 4),
        width: clamp(width, LIMITS.width, 520),
        height: clamp(height, LIMITS.height, 240),
      });
      setNote({ ok: true, text: `แทรกตารางแล้ว · ${count} elements` });
    } catch (error) {
      setNote({ ok: false, text: error?.message || String(error) });
    }
  };

  return (
    <aside className={`panel${open ? " open" : ""}`} aria-hidden={!open} inert={!open}>
      <div className="panel-head">
        <span className="panel-title">ตาราง</span>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="ปิด" title="ปิด">
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            aria-hidden="true"
            focusable="false"
          >
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      <div className="panel-body">
        <label>
          หัวเรื่อง (ไม่บังคับ)
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="inventory.lot" />
        </label>

        {/* A table that is already on the canvas grows, shrinks and resizes on the
            canvas itself: + / - on all four edges for whole rows and columns, and
            a border drag for one track's size. Keeping a second set of the same
            controls here only let the two disagree, so the panel keeps the jobs
            the canvas cannot do — heading, colour and header row. */}
        {selected ? (
          <p className="hint">
            เลือกอยู่: ตาราง {selected.cols} × {selected.rows} — ลากขอบช่องเพื่อยืดแถว/คอลัมน์ หรือกด + / − ที่ขอบบน-ล่าง
            (แถว) และซ้าย-ขวา (คอลัมน์) บนตัวตาราง
          </p>
        ) : (
          <>
            <div className="row">
              <NumberField label="จำนวนคอลัมน์" value={columns} limits={LIMITS.columns} fallback={3} onChange={setColumns} />
              <NumberField label="จำนวนแถว" value={rows} limits={LIMITS.rows} fallback={4} onChange={setRows} />
            </div>

            <div className="row">
              <NumberField label="ความกว้างรวม (px)" value={width} limits={LIMITS.width} fallback={520} step={10} onChange={setWidth} />
              <NumberField label="ความสูงรวม (px)" value={height} limits={LIMITS.height} fallback={240} step={10} onChange={setHeight} />
            </div>
          </>
        )}

        <div className="row">
          <label className="grow">
            สีหัวตาราง
            <select value={color} onChange={(e) => setColor(e.target.value)}>
              {COLORS.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={headerRow} onChange={(e) => setHeaderRow(e.target.checked)} />
            แถวแรกเป็นหัวตาราง
          </label>
        </div>

        {selected ? null : (
          <p className="hint">
            {columns} × {rows} ช่อง · {width}×{height} px · ช่องละ ~{cellW}×{cellH} px — จะวางต่อท้ายด้านขวาของกระดาน
          </p>
        )}

        {selected && (
          <button
            type="button"
            className="btn primary wide"
            onClick={() =>
              run(
                () =>
                  onUpdate({
                    columns: clamp(columns, LIMITS.columns, 3),
                    rows: clamp(rows, LIMITS.rows, 4),
                    width: clamp(width, LIMITS.width, 520),
                    height: clamp(height, LIMITS.height, 240),
                    // the heading, colour and header flag are edited in the same
                    // panel, so the update button has to carry them too
                    title: title.trim(),
                    color,
                    headerRow,
                  }),
                "อัปเดตตารางแล้ว",
              )
            }
          >
            อัปเดตหัวตาราง สี และแถวหัว
          </button>
        )}

        <button type="button" className={`btn wide${selected ? "" : " primary"}`} onClick={insert}>
          แทรกตารางใหม่
        </button>

        {note && <p className={note.ok ? "note ok" : "note bad"}>{note.text}</p>}
      </div>
    </aside>
  );
}
