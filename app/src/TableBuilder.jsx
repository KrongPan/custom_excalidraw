import { useEffect, useRef, useState } from "react";

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

const SIZE_LIMITS = {
  row: [24, 1200],
  col: [40, 1600],
};

export default function TableBuilder({
  open,
  onClose,
  onInsert,
  selected,
  onUpdate,
  onGrow,
  active,
  onResizeRow,
  onResizeCol,
  onPreviewRow,
  onPreviewCol,
}) {
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

  // the cell the user last clicked decides which row / column the size fields aim at
  const rowIndex = active && active.grid === selected?.grid ? active.r : null;
  const colIndex = active && active.grid === selected?.grid ? active.c : null;
  const rowSize = rowIndex != null ? selected?.rowHeights?.[rowIndex] ?? cellH : null;
  const colSize = colIndex != null ? selected?.colWidths?.[colIndex] ?? cellW : null;
  const [rowDraft, setRowDraft] = useState(rowSize ?? cellH);
  const [colDraft, setColDraft] = useState(colSize ?? cellW);

  useEffect(() => {
    if (rowSize != null) setRowDraft(rowSize);
  }, [rowSize, rowIndex]);

  useEffect(() => {
    if (colSize != null) setColDraft(colSize);
  }, [colSize, colIndex]);

  const run = (fn, label) => {
    try {
      const count = fn();
      setNote({ ok: true, text: `${label} · ${count} elements` });
    } catch (error) {
      setNote({ ok: false, text: error?.message || String(error) });
    }
  };

  const act = (fn, text) => {
    try {
      fn();
      setNote({ ok: true, text });
    } catch (error) {
      setNote({ ok: false, text: error?.message || String(error) });
    }
  };

  const applyRow = (value) => {
    if (rowIndex == null) return;
    const next = clamp(value, SIZE_LIMITS.row, rowSize ?? cellH);
    setRowDraft(next);
    act(() => onResizeRow?.(rowIndex, next), `แถว ${rowIndex + 1} สูง ${next} px`);
  };

  const applyCol = (value) => {
    if (colIndex == null) return;
    const next = clamp(value, SIZE_LIMITS.col, colSize ?? cellW);
    setColDraft(next);
    act(() => onResizeCol?.(colIndex, next), `คอลัมน์ ${colIndex + 1} กว้าง ${next} px`);
  };

  /* Sliders preview while the thumb moves and only commit when it is released, so
     one drag is one undo step and one save. The number field stays for exact px. */
  const previewRow = (value) => {
    if (rowIndex == null) return;
    const next = clamp(value, SIZE_LIMITS.row, rowSize ?? cellH);
    setRowDraft(next);
    onPreviewRow?.(rowIndex, next);
  };

  const previewCol = (value) => {
    if (colIndex == null) return;
    const next = clamp(value, SIZE_LIMITS.col, colSize ?? cellW);
    setColDraft(next);
    onPreviewCol?.(colIndex, next);
  };

  /* A slider commits when a drag (or a keyboard nudge) ends, never on blur: the
     draft still holds the value the thumb was left at, so a blur caused by an
     unrelated click — pressing Cmd+Z on the board, switching rows — used to
     re-apply that stale size and overwrite the restored one. */
  const rowDragRef = useRef(false);
  const colDragRef = useRef(false);

  const endRowDrag = () => {
    if (!rowDragRef.current) return;
    rowDragRef.current = false;
    if (rowIndex != null) applyRow(rowDraft);
  };

  const endColDrag = () => {
    if (!colDragRef.current) return;
    colDragRef.current = false;
    if (colIndex != null) applyCol(colDraft);
  };

  /** Focus left the slider without a drag: drop the draft, keep the real size. */
  const dropRowDrag = () => {
    rowDragRef.current = false;
    setRowDraft(rowSize ?? cellH);
  };

  const dropColDrag = () => {
    colDragRef.current = false;
    setColDraft(colSize ?? cellW);
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

        <div className="row">
          <NumberField label="จำนวนคอลัมน์" value={columns} limits={LIMITS.columns} fallback={3} onChange={setColumns} />
          <NumberField label="จำนวนแถว" value={rows} limits={LIMITS.rows} fallback={4} onChange={setRows} />
        </div>

        <div className="row">
          <NumberField label="ความกว้างรวม (px)" value={width} limits={LIMITS.width} fallback={520} step={10} onChange={setWidth} />
          <NumberField label="ความสูงรวม (px)" value={height} limits={LIMITS.height} fallback={240} step={10} onChange={setHeight} />
        </div>

        {selected && (
          <div className="grid-sizing">
            <p className="hint">
              {rowIndex != null
                ? `กำลังปรับแถว ${rowIndex + 1} · คอลัมน์ ${colIndex + 1}`
                : "คลิกช่องในตารางเพื่อเลือกแถวและคอลัมน์ที่ต้องการปรับ"}
            </p>
            <div className="row">
              <label className="grow">
                ความสูงแถว {rowIndex != null ? rowIndex + 1 : "—"} (px)
                <input
                  type="number"
                  aria-label="ความสูงของแถวที่เลือก"
                  min={SIZE_LIMITS.row[0]}
                  max={SIZE_LIMITS.row[1]}
                  step={5}
                  value={rowDraft}
                  disabled={rowIndex == null}
                  onChange={(e) => setRowDraft(e.target.value)}
                  onBlur={() => applyRow(rowDraft)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") applyRow(rowDraft);
                  }}
                />
              </label>
              <button
                type="button"
                className="btn small"
                disabled={rowIndex == null}
                aria-label="ลดความสูงแถว"
                onClick={() => applyRow((Number(rowDraft) || rowSize || cellH) - 10)}
              >
                −
              </button>
              <button
                type="button"
                className="btn small"
                disabled={rowIndex == null}
                aria-label="เพิ่มความสูงแถว"
                onClick={() => applyRow((Number(rowDraft) || rowSize || cellH) + 10)}
              >
                +
              </button>
            </div>
            <input
              type="range"
              className="size-slider"
              aria-label="สไลเดอร์ความสูงของแถวที่เลือก"
              min={SIZE_LIMITS.row[0]}
              max={SIZE_LIMITS.row[1]}
              step={5}
              value={clamp(rowDraft, SIZE_LIMITS.row, rowSize ?? cellH)}
              disabled={rowIndex == null}
              onChange={(e) => previewRow(e.target.value)}
              onPointerDown={() => {
                rowDragRef.current = true;
              }}
              onKeyDown={() => {
                rowDragRef.current = true;
              }}
              onPointerUp={endRowDrag}
              onTouchEnd={endRowDrag}
              onKeyUp={endRowDrag}
              onBlur={dropRowDrag}
            />
            <div className="row">
              <label className="grow">
                ความกว้างคอลัมน์ {colIndex != null ? colIndex + 1 : "—"} (px)
                <input
                  type="number"
                  aria-label="ความกว้างของคอลัมน์ที่เลือก"
                  min={SIZE_LIMITS.col[0]}
                  max={SIZE_LIMITS.col[1]}
                  step={5}
                  value={colDraft}
                  disabled={colIndex == null}
                  onChange={(e) => setColDraft(e.target.value)}
                  onBlur={() => applyCol(colDraft)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") applyCol(colDraft);
                  }}
                />
              </label>
              <button
                type="button"
                className="btn small"
                disabled={colIndex == null}
                aria-label="ลดความกว้างคอลัมน์"
                onClick={() => applyCol((Number(colDraft) || colSize || cellW) - 10)}
              >
                −
              </button>
              <button
                type="button"
                className="btn small"
                disabled={colIndex == null}
                aria-label="เพิ่มความกว้างคอลัมน์"
                onClick={() => applyCol((Number(colDraft) || colSize || cellW) + 10)}
              >
                +
              </button>
            </div>
            <input
              type="range"
              className="size-slider"
              aria-label="สไลเดอร์ความกว้างของคอลัมน์ที่เลือก"
              min={SIZE_LIMITS.col[0]}
              max={SIZE_LIMITS.col[1]}
              step={5}
              value={clamp(colDraft, SIZE_LIMITS.col, colSize ?? cellW)}
              disabled={colIndex == null}
              onChange={(e) => previewCol(e.target.value)}
              onPointerDown={() => {
                colDragRef.current = true;
              }}
              onKeyDown={() => {
                colDragRef.current = true;
              }}
              onPointerUp={endColDrag}
              onTouchEnd={endColDrag}
              onKeyUp={endColDrag}
              onBlur={dropColDrag}
            />
          </div>
        )}

        {selected && (
          <div className="selected-grid">
            <p className="hint">
              เลือกอยู่: ตาราง {selected.cols} × {selected.rows} — เปลี่ยนตัวเลขแล้วกด “อัปเดตตารางที่เลือก” (ข้อความในช่องเดิมยังอยู่)
            </p>
            <div className="row">
              <button type="button" className="btn small" onClick={() => run(() => onGrow("row"), "เพิ่มแถวแล้ว")}>
                + 1 แถว
              </button>
              <button type="button" className="btn small" onClick={() => run(() => onGrow("col"), "เพิ่มคอลัมน์แล้ว")}>
                + 1 คอลัมน์
              </button>
            </div>
          </div>
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

        <p className="hint">
          {columns} × {rows} ช่อง · {width}×{height} px · ช่องละ ~{cellW}×{cellH} px — จะวางต่อท้ายด้านขวาของกระดาน
        </p>

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
            อัปเดตตารางที่เลือก
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
