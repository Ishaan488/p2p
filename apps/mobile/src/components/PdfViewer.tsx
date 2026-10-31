import React, { useState, useEffect } from 'react';
import { FileText, ExternalLink, Download, X } from 'lucide-react';
import { formatBytes } from '../lib/telemetry';
import { backButtonManager } from '../lib/backButton';

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

  useEffect(() => {
    if (!isOpen) return;
    const unregister = backButtonManager.push(() => {
      setIsOpen(false);
      return true;
    });
    return unregister;
  }, [isOpen]);

  const handleOpen = () => {
    // If running on desktop, window.open or modal iframe works great
    setIsOpen(true);
  };

  return (
    <>
      <div className="pdf-card">
        <div className="pdf-badge-icon">
          <FileText size={22} color="#ff3b30" />
          <span className="pdf-ext-tag">PDF</span>
        </div>

        <div className="pdf-info">
          <div className="pdf-title" title={filename}>{filename}</div>
          <div className="pdf-size">{fileSize !== undefined ? formatBytes(fileSize) : 'PDF Document'}</div>
        </div>

        <div className="pdf-actions">
          <button className="pdf-open-btn" onClick={handleOpen} title="Open PDF">
            <ExternalLink size={15} />
            <span>View</span>
          </button>
          {onDownload && (
            <button className="icon-btn" onClick={onDownload} title="Download PDF">
              <Download size={16} />
            </button>
          )}
        </div>
      </div>

      {isOpen && (
        <div className="pdf-modal-overlay" onClick={() => setIsOpen(false)}>
          <div className="pdf-modal-content" onClick={e => e.stopPropagation()}>
            <div className="pdf-modal-header">
              <div className="pdf-modal-title">{filename}</div>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <a
                  href={src}
                  target="_blank"
                  rel="noreferrer"
                  className="icon-btn"
                  title="Open in new window"
                >
                  <ExternalLink size={18} />
                </a>
                {onDownload && (
                  <button className="icon-btn" onClick={onDownload} title="Download">
                    <Download size={18} />
                  </button>
                )}
                <button className="icon-btn" onClick={() => setIsOpen(false)} title="Close">
                  <X size={20} />
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
