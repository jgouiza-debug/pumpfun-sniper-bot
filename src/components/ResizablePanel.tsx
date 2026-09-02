import React, { useCallback, useRef, useState } from 'react';

/**
 * Drag-to-resize wrapper used by every major box on both pages (positions,
 * receipts, logs, scout, smart money, wallets, copy positions/receipts, the
 * feed). One primitive, reused everywhere, instead of five bespoke ones.
 *
 * Plain pointer events, no dependency — this app has never pulled in a
 * drag/resize library and there is no reason to start for something this
 * small. Size is persisted per `id` in localStorage so a dragged layout
 * survives a restart; the small ↺ button clears the override.
 *
 * Width can only SHRINK the panel inside its column (capped at 100% via CSS)
 * — a panel growing past its column would either overflow or fight the
 * column's own width, and the column width is itself the thing the split
 * handle between the two columns controls. Height is free within min/max.
 */

interface StoredSize {
  width?: number;
  height?: number;
}

function readStored(key: string): StoredSize {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeStored(key: string, size: StoredSize): void {
  try {
    if (size.width === undefined && size.height === undefined) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify(size));
    }
  } catch { /* private browsing / storage full — just don't persist */ }
}

export interface ResizablePanelProps {
  /** Unique per-panel key for the persisted size. */
  id: string;
  resize?: 'width' | 'height' | 'both' | 'none';
  minWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}

export function ResizablePanel({
  id, resize = 'both', minWidth = 220, minHeight = 90, maxHeight,
  className, style, children,
}: ResizablePanelProps): React.ReactElement {
  const storageKey = `panelSize:${id}`;
  const [size, setSize] = useState<StoredSize>(() => readStored(storageKey));
  const boxRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ axis: 'width' | 'height'; startPos: number; startSize: number } | null>(null);

  const onPointerMove = useCallback((e: PointerEvent) => {
    const d = drag.current;
    const box = boxRef.current;
    if (!d || !box) return;
    const delta = (d.axis === 'width' ? e.clientX : e.clientY) - d.startPos;
    const floor = d.axis === 'width' ? minWidth : minHeight;
    let next = Math.max(floor, d.startSize + delta);
    if (d.axis === 'height' && maxHeight) next = Math.min(next, maxHeight);
    setSize(prev => {
      const merged = { ...prev, [d.axis]: next };
      writeStored(storageKey, merged);
      return merged;
    });
  }, [minWidth, minHeight, maxHeight, storageKey]);

  const onPointerUp = useCallback(() => {
    drag.current = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
  }, [onPointerMove]);

  const startDrag = useCallback((axis: 'width' | 'height') => (e: React.PointerEvent) => {
    e.preventDefault();
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect) return;
    drag.current = {
      axis,
      startPos: axis === 'width' ? e.clientX : e.clientY,
      startSize: axis === 'width' ? rect.width : rect.height,
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  }, [onPointerMove, onPointerUp]);

  const reset = useCallback(() => {
    writeStored(storageKey, {});
    setSize({});
  }, [storageKey]);

  const hasOverride = size.width !== undefined || size.height !== undefined;
  const showWidthHandle = resize === 'width' || resize === 'both';
  const showHeightHandle = resize === 'height' || resize === 'both';

  return (
    <div
      ref={boxRef}
      className={`resizable-panel${className ? ` ${className}` : ''}`}
      style={{
        ...style,
        position: 'relative',
        ...(size.width !== undefined ? { width: size.width, maxWidth: '100%', flexShrink: 0 } : {}),
        ...(size.height !== undefined ? { height: size.height, flex: 'none' } : {}),
      }}
    >
      {children}
      {showWidthHandle && (
        <div
          className="resize-handle resize-handle-e"
          onPointerDown={startDrag('width')}
          title="Drag to resize width"
        />
      )}
      {showHeightHandle && (
        <div
          className="resize-handle resize-handle-s"
          onPointerDown={startDrag('height')}
          title="Drag to resize height"
        />
      )}
      {hasOverride && (
        <button
          type="button"
          className="resize-reset"
          onClick={reset}
          title="Reset to default size"
          aria-label="Reset panel size"
        >↺</button>
      )}
    </div>
  );
}

/**
 * The drag handle between the two main columns (left work area / right feed).
 * Shared by App.tsx and CopyTradingPage.tsx — they already reuse the same
 * `.main-viewport-grid` markup, so one handle serves both.
 */
const COLUMN_SPLIT_KEY = 'panelSize:mainColumnSplit';
const COLUMN_SPLIT_DEFAULT = 62; // left column, percent of the grid width
const COLUMN_SPLIT_MIN = 30;
const COLUMN_SPLIT_MAX = 80;

function readColumnSplit(): number {
  try {
    const raw = localStorage.getItem(COLUMN_SPLIT_KEY);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) ? Math.min(COLUMN_SPLIT_MAX, Math.max(COLUMN_SPLIT_MIN, n)) : COLUMN_SPLIT_DEFAULT;
  } catch {
    return COLUMN_SPLIT_DEFAULT;
  }
}

export function useColumnSplit(): { leftPct: number; onHandlePointerDown: (e: React.PointerEvent) => void; reset: () => void; isDefault: boolean } {
  const [leftPct, setLeftPct] = useState<number>(readColumnSplit);
  const drag = useRef<{ startX: number; startPct: number; gridWidth: number } | null>(null);

  const onPointerMove = useCallback((e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const deltaPct = ((e.clientX - d.startX) / d.gridWidth) * 100;
    const next = Math.min(COLUMN_SPLIT_MAX, Math.max(COLUMN_SPLIT_MIN, d.startPct + deltaPct));
    setLeftPct(next);
    try { localStorage.setItem(COLUMN_SPLIT_KEY, String(next)); } catch { /* ignore */ }
  }, []);

  const onPointerUp = useCallback(() => {
    drag.current = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
  }, [onPointerMove]);

  const onHandlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const grid = (e.target as HTMLElement).closest('.main-viewport-grid') as HTMLElement | null;
    if (!grid) return;
    drag.current = { startX: e.clientX, startPct: leftPct, gridWidth: grid.getBoundingClientRect().width };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  }, [leftPct, onPointerMove, onPointerUp]);

  const reset = useCallback(() => {
    setLeftPct(COLUMN_SPLIT_DEFAULT);
    try { localStorage.removeItem(COLUMN_SPLIT_KEY); } catch { /* ignore */ }
  }, []);

  return { leftPct, onHandlePointerDown, reset, isDefault: Math.round(leftPct) === COLUMN_SPLIT_DEFAULT };
}
