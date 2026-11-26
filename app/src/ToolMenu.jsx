import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/* Extra tools live behind one overflow button, the way excalidraw.com keeps
   Frame, Web Embed, Laser and the generators in its "More tools" menu. The row
   then shows only the drawing tools; table, minimap and lasso are one click in.

   The trigger is portalled into the native tools row (so it inherits the row's
   layout), while the menu itself is portalled to <body> and positioned in
   viewport coordinates: the island is a fixed, transformed box, and a menu
   inside it would fight the row's flex sizing and the drag gesture. */

const MENU_W = 232;
const EDGE = 10;
const GAP = 8;

const IconMore = () => (
  <svg
    width={17}
    height={17}
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
    focusable="false"
  >
    <circle cx="12" cy="5.4" r="1.7" />
    <circle cx="12" cy="12" r="1.7" />
    <circle cx="12" cy="18.6" r="1.7" />
  </svg>
);

const IconCheck = () => (
  <svg
    width={14}
    height={14}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2.2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M4.5 12.5l5 5 10-11" />
  </svg>
);

export default function ToolMenu({ host, items = [], open, onOpenChange }) {
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const [pos, setPos] = useState(null);

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const menu = menuRef.current;
    const menuH = menu ? menu.getBoundingClientRect().height : 0;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    // right-aligned with the trigger, like Excalidraw's own dropdown
    const left = Math.min(Math.max(EDGE, rect.right - MENU_W), Math.max(EDGE, vw - MENU_W - EDGE));
    const below = rect.bottom + GAP;
    const top =
      menuH && below + menuH > vh - EDGE ? Math.max(EDGE, rect.top - GAP - menuH) : below;
    setPos({ left: Math.round(left), top: Math.round(top) });
  }, []);

  /* Measure after the menu is in the DOM: it has to know its own height before
     it can decide whether to open downwards or upwards. */
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event) => {
      const target = event.target;
      if (menuRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      onOpenChange(false);
    };
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onOpenChange(false);
      triggerRef.current?.focus();
    };
    const onMove = () => place();
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open, place, onOpenChange]);

  const pick = (item) => {
    item.onSelect?.();
    if (item.keepOpen) {
      place();
      return;
    }
    onOpenChange(false);
    triggerRef.current?.focus();
  };

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      className={`tools-more${open ? " active" : ""}`}
      onClick={() => onOpenChange(!open)}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label="เครื่องมือเพิ่มเติม"
      title="เครื่องมือเพิ่มเติม"
    >
      <IconMore />
    </button>
  );

  return (
    <>
      {/* Nothing before the native row exists: a trigger rendered straight into
          .shell would float loose until the tools effect attaches. */}
      {host ? createPortal(trigger, host) : null}
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="tools-more-menu"
            role="menu"
            aria-label="เครื่องมือเพิ่มเติม"
            style={{
              left: pos ? `${pos.left}px` : "-9999px",
              top: pos ? `${pos.top}px` : "-9999px",
              width: `${MENU_W}px`,
            }}
          >
            <p className="tools-more-cap">เครื่องมือเพิ่มเติม</p>
            {items.map((item) => (
              <button
                key={item.key}
                type="button"
                role={item.active === undefined ? "menuitem" : "menuitemcheckbox"}
                aria-checked={item.active === undefined ? undefined : Boolean(item.active)}
                className={`tools-more-row${item.active ? " active" : ""}`}
                onClick={() => pick(item)}
                title={item.title || item.label}
              >
                <span className="tools-more-icon">{item.icon}</span>
                <span className="tools-more-label">{item.label}</span>
                {item.hint ? <span className="tools-more-hint">{item.hint}</span> : null}
                <span className="tools-more-tick" aria-hidden="true">
                  {item.active ? <IconCheck /> : null}
                </span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
