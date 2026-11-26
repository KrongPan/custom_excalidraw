import { useEffect, useState } from "react";

/* Side panel for the ER diagram plugin. It is deliberately separate from the
   normal table builder: tables and ER class nodes are different contexts. */

const DEFAULT_FIELDS = "+ field: type\n+ field: type\n+ field: type";
const DEFAULT_METHODS = "+ method(type): type";
const WIDTH_LIMITS = [180, 900];

function clamp(value, [lo, hi], fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

export default function ErBuilder({ open, onClose, selected, onUpdate }) {
  const [title, setTitle] = useState("Classname");
  const [fields, setFields] = useState(DEFAULT_FIELDS);
  const [methods, setMethods] = useState(DEFAULT_METHODS);
  const [width, setWidth] = useState(320);
  const [note, setNote] = useState(null);

  useEffect(() => {
    if (!open || !selected) return;
    setTitle(selected.title ?? "Classname");
    setFields((selected.fields ?? []).join("\n"));
    setMethods((selected.methods ?? []).join("\n"));
    setWidth(selected.width ?? 320);
  }, [open, selected?.grid, selected?.title, selected?.width, selected?.fields?.join("\n"), selected?.methods?.join("\n")]);

  const update = () => {
    try {
      const count = onUpdate({
        kind: "class",
        title: String(title).trim() || "Classname",
        fields: fields.split(/\r?\n/),
        methods: methods.split(/\r?\n/),
        width: clamp(width, WIDTH_LIMITS, 320),
      });
      setNote({ ok: true, text: `อัปเดต ER class แล้ว · ${count} elements` });
    } catch (error) {
      setNote({ ok: false, text: error?.message || String(error) });
    }
  };

  return (
    <aside className={`panel er-panel${open ? " open" : ""}`} aria-hidden={!open} inert={!open}>
      <div className="panel-head">
        <span className="panel-title">ER diagram</span>
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
        {!selected ? (
          <p className="hint">
            กดปุ่ม ER บน toolbar เพื่อวาง class กลางจอ แล้วเลือก class เพื่อแก้ชื่อ,
            fields และ methods ที่นี่
          </p>
        ) : (
          <>
            <label>
              ชื่อ class
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Classname" />
            </label>

            <label>
              Fields (หนึ่งบรรทัดต่อ field)
              <textarea
                rows={5}
                value={fields}
                onChange={(e) => setFields(e.target.value)}
                placeholder="+ field: type"
              />
            </label>

            <label>
              Methods (หนึ่งบรรทัดต่อ method)
              <textarea
                rows={4}
                value={methods}
                onChange={(e) => setMethods(e.target.value)}
                placeholder="+ method(type): type"
              />
            </label>

            <label>
              ความกว้าง (px)
              <input
                type="number"
                min={WIDTH_LIMITS[0]}
                max={WIDTH_LIMITS[1]}
                step={10}
                value={width}
                onChange={(e) => setWidth(e.target.value)}
                onBlur={() => setWidth(clamp(width, WIDTH_LIMITS, 320))}
              />
            </label>

            <p className="hint">
              คลิกบรรทัดในกล่องเพื่อแก้ทีละ field/method · ปุ่ม `−` ย่อเหลือหัว class
            </p>

            <button type="button" className="btn primary wide" onClick={update}>
              อัปเดต class ที่เลือก
            </button>
          </>
        )}

        {note && <p className={note.ok ? "note ok" : "note bad"}>{note.text}</p>}
      </div>
    </aside>
  );
}
