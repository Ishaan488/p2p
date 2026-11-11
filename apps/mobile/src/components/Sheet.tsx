import React, { useCallback, useEffect, useRef, useState } from 'react';
import { X } from './icons';
import { backButtonManager } from '../lib/backButton';

export interface SheetProps {
  open: boolean;
  title?: string;
  description?: string;
  onClose: () => void;
  /** Footer actions (buttons). */
  footer?: React.ReactNode;
  stackedFooter?: boolean;
  /** Remove horizontal body padding (for full-bleed rows). */
  flush?: boolean;
  /** Show the close (X) button in the header. */
  closable?: boolean;
  children?: React.ReactNode;
}

const EXIT_MS = 220;
const DISMISS_DISTANCE = 96;

/**
 * Unified bottom sheet: same radius, handle, spacing and motion for every variant
 * (action, selection, details, settings, confirm). Drag the handle down, tap the
 * scrim, press Escape or the Android back button to dismiss.
 */
export const Sheet: React.FC<SheetProps> = ({
  open, title, description, onClose, footer, stackedFooter, flush, closable = true, children,
}) => {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);
  const [drag, setDrag] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startY = useRef<number | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (open) {
      setMounted(true);
      const id = requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)));
      return () => cancelAnimationFrame(id);
    }
    setVisible(false);
    const t = setTimeout(() => { setMounted(false); setDrag(0); }, EXIT_MS);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    return backButtonManager.push(() => { onCloseRef.current(); return true; });
  }, [open]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    startY.current = e.clientY;
    setDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }, []);
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (startY.current == null) return;
    setDrag(Math.max(0, e.clientY - startY.current));
  }, []);
  const endDrag = useCallback(() => {
    if (startY.current == null) return;
    startY.current = null;
    setDragging(false);
    setDrag(d => {
      if (d > DISMISS_DISTANCE) { queueMicrotask(() => onCloseRef.current()); return 0; }
      return 0;
    });
  }, []);

  if (!mounted) return null;

  return (
    <div className="sheet-root" data-state={visible ? 'open' : 'closed'}>
      <div className="sheet-scrim" onClick={onClose} aria-hidden="true" />
      <div
        className={`sheet${dragging ? ' is-dragging' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ ['--drag' as string]: `${drag}px` }}
      >
        <div
          className="sheet-grab"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <div className="sheet-handle" />
        </div>
        {(title || closable) && (
          <div className="sheet-head">
            <div className="sheet-head-text">
              {title && <h2 className="sheet-title">{title}</h2>}
              {description && <p className="sheet-desc">{description}</p>}
            </div>
            {closable && (
              <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" style={{ marginTop: -8, marginRight: -12 }}>
                <X size={20} />
              </button>
            )}
          </div>
        )}
        <div className={`sheet-body${flush ? ' flush' : ''}`}>{children}</div>
        {footer && <div className={`sheet-foot${stackedFooter ? ' stacked' : ''}`}>{footer}</div>}
      </div>
    </div>
  );
};

export default Sheet;
