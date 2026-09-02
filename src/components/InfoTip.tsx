import React, { useEffect, useRef, useState } from 'react';

/**
 * A small "(?)" that opens the full explanation on click.
 *
 * Click, not hover-only: this is an Electron app, and click also works for
 * anyone on a trackpad tap or a touch screen where hover never fires. Used to
 * move long explanatory paragraphs out of the main flow — the reasoning is
 * kept verbatim, just opt-in instead of always on screen.
 */
export function InfoTip({ children }: { children: React.ReactNode }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <span className="info-tip" ref={ref}>
      <button
        type="button"
        className="info-tip-trigger"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-label="More information"
      >?</button>
      {open && <div className="info-tip-popover">{children}</div>}
    </span>
  );
}
