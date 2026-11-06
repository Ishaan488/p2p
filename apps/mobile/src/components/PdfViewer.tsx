import React, { useState, useEffect, useRef } from 'react';
import { FileText, ExternalLink, Download, X, Eye } from 'lucide-react';
import { formatBytes } from '../lib/telemetry';
import { backButtonManager } from '../lib/backButton';
import { Capacitor } from '@capacitor/core';

interface PdfViewerProps {
  src: string;
  filename: string;
  fileSize?: number;
  onDownload?: () => void;
}

export const PdfViewer: React.FC<PdfViewerProps> = ({
  src,
  filename,
  fileSize,
  onDownload
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);
  const isNative = Capacitor.isNativePlatform();

  useEffect(() => {
    if (!isOpen) return;
    const prevFocus = document.activeElement as HTMLElement | null;
    const unregister = backButtonManager.push(() => {
      setIsOpen(false);
      return true;
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !modalRef.current) return;
      const focusable = modalRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], iframe, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      unregister();
      window.removeEventListener('keydown', onKey);
      prevFocus?.focus?.();
    };
  }, [isOpen]);

  return (
    <>
      <div className="pdf-card">
        <div className="pdf-badge-icon">
          <FileText size={20} />
        </div>

        <div className="pdf-info">
          <div className="pdf-title" title={filename}>{filename}</div>
          <div className="pdf-meta-row">
            <span className="file-ext-pill pdf-pill">PDF</span>
            <span className="pdf-size">
              {fileSize !== undefined ? formatBytes(fileSize) : 'Document'}
            </span>
          </div>
        </div>

        <div className="pdf-actions">
          {!isNative && (
            <button
              type="button"
              className="pdf-open-btn"
              onClick={() => setIsOpen(true)}
              title="Preview PDF"
            >
              <Eye size={14} />
              <span>Preview</span>
            </button>
          )}
          {onDownload && (
            <button
              type="button"
              className="pdf-open-btn"
              onClick={onDownload}
              title="Save PDF to Downloads"
            >
              <Download size={14} />
              <span>Save PDF</span>
            </button>
          )}
        </div>
      </div>

      {isOpen && (
        <div
          className="pdf-modal-overlay"
          onClick={() => setIsOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label={`PDF preview: ${filename}`}
        >
          <div ref={modalRef} className="pdf-modal-content" onClick={e => e.stopPropagation()}>
            <div className="pdf-modal-header">
              <div className="pdf-modal-title-group">
                <FileText size={16} />
                <span className="pdf-modal-title">{filename}</span>
              </div>
              <div className="pdf-modal-actions">
                <a
                  href={src}
                  target="_blank"
                  rel="noreferrer"
                  className="icon-btn"
                  title="Open in new tab"
                  aria-label="Open PDF in new tab"
                >
                  <ExternalLink size={16} />
                </a>
                {onDownload && (
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={onDownload}
                    title="Save PDF"
                    aria-label="Save PDF"
                  >
                    <Download size={16} />
                  </button>
                )}
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setIsOpen(false)}
                  title="Close"
                  aria-label="Close PDF preview"
                >
                  <X size={18} />
                </button>
              </div>
            </div>
            <div className="pdf-modal-body">
              <iframe src={src} title={filename} className="pdf-iframe" />
            </div>
          </div>
        </div>
      )}
    </>
  );
};
