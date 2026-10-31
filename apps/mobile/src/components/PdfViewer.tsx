import React, { useState, useEffect } from 'react';
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
  const isNative = Capacitor.isNativePlatform();

  useEffect(() => {
    if (!isOpen) return;
    const unregister = backButtonManager.push(() => {
      setIsOpen(false);
      return true;
    });
    return unregister;
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
        <div className="pdf-modal-overlay" onClick={() => setIsOpen(false)} role="dialog" aria-modal="true">
          <div className="pdf-modal-content" onClick={e => e.stopPropagation()}>
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
                >
                  <ExternalLink size={16} />
                </a>
                {onDownload && (
                  <button type="button" className="icon-btn" onClick={onDownload} title="Save PDF">
                    <Download size={16} />
                  </button>
                )}
                <button type="button" className="icon-btn" onClick={() => setIsOpen(false)} title="Close">
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
