import React, { useState, useEffect } from 'react';
import { Copy, Check, Maximize2, Download, X, Code2 } from 'lucide-react';
import { getLanguageLabel, formatBytes } from '../lib/telemetry';
import { backButtonManager } from '../lib/backButton';
import { Clipboard } from '@capacitor/clipboard';

interface CodeViewerProps {
  filename: string;
  snippet: string;
  fullContent?: string;
  totalLines?: number;
  fileSize?: number;
  onDownload?: () => void;
  onCopyNotice?: (msg: string, type?: 'info' | 'success' | 'warning') => void;
}

export const CodeViewer: React.FC<CodeViewerProps> = ({
  filename,
  snippet,
  fullContent,
  totalLines,
  fileSize,
  onDownload,
  onCopyNotice
}) => {
  const [copied, setCopied] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);

  useEffect(() => {
    if (!isModalOpen) return;
    const unregister = backButtonManager.push(() => {
      setIsModalOpen(false);
      return true;
    });
    return unregister;
  }, [isModalOpen]);

  const contentToCopy = fullContent || snippet;

  const handleCopy = async () => {
    try {
      await Clipboard.write({ string: contentToCopy });
    } catch {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(contentToCopy).catch(() => {});
      }
    }
    setCopied(true);
    if (onCopyNotice) {
      onCopyNotice(`Copied ${filename}`, 'success');
    }
    setTimeout(() => setCopied(false), 2000);
  };

  const lines = snippet.split('\n');
  const langLabel = getLanguageLabel(filename);
  const fullLines = (fullContent || snippet).split('\n');

  return (
    <>
      <div className="code-viewer-card">
        <div className="code-viewer-header">
          <div className="code-viewer-left">
            <Code2 size={15} className="code-icon" />
            <span className="code-filename" title={filename}>{filename}</span>
            <span className="file-ext-pill">{langLabel}</span>
            {fileSize !== undefined && (
              <span className="code-size-pill">{formatBytes(fileSize)}</span>
            )}
          </div>

          <div className="code-viewer-actions">
            <button
              type="button"
              className="code-action-btn"
              onClick={handleCopy}
              title="Copy code"
            >
              {copied ? <Check size={13} color="var(--success)" /> : <Copy size={13} />}
              <span>{copied ? 'Copied' : 'Copy'}</span>
            </button>

            {((fullContent && totalLines && totalLines > lines.length) || lines.length > 6) && (
              <button
                type="button"
                className="code-action-btn"
                onClick={() => setIsModalOpen(true)}
                title="View full source"
              >
                <Maximize2 size={12} />
                <span>Expand</span>
              </button>
            )}
          </div>
        </div>

        <div className="code-snippet-box">
          <table className="code-table">
            <tbody>
              {lines.slice(0, 12).map((line, idx) => (
                <tr key={idx}>
                  <td className="code-line-num">{idx + 1}</td>
                  <td className="code-line-text">{line || ' '}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {((totalLines && totalLines > 12) || lines.length > 12) && (
            <button
              type="button"
              className="code-more-indicator"
              onClick={() => setIsModalOpen(true)}
            >
              <span>
                View all {totalLines || lines.length} lines
              </span>
            </button>
          )}
        </div>
      </div>

      {isModalOpen && (
        <div className="code-modal-overlay" onClick={() => setIsModalOpen(false)} role="dialog" aria-modal="true">
          <div className="code-modal-content" onClick={e => e.stopPropagation()}>
            <div className="code-modal-header">
              <div className="code-modal-title">
                <Code2 size={16} />
                <span className="code-modal-filename">{filename}</span>
                <span className="file-ext-pill">{langLabel}</span>
                {totalLines && <span className="code-size-pill">{totalLines} lines</span>}
              </div>

              <div className="code-modal-actions">
                <button type="button" className="code-action-btn" onClick={handleCopy}>
                  {copied ? <Check size={13} color="var(--success)" /> : <Copy size={13} />}
                  <span>{copied ? 'Copied' : 'Copy All'}</span>
                </button>
                {onDownload && (
                  <button type="button" className="icon-btn" onClick={onDownload} title="Save File">
                    <Download size={16} />
                  </button>
                )}
                <button type="button" className="icon-btn" onClick={() => setIsModalOpen(false)} title="Close">
                  <X size={18} />
                </button>
              </div>
            </div>

            <div className="code-modal-body">
              <table className="code-table code-table-full">
                <tbody>
                  {fullLines.map((line, idx) => (
                    <tr key={idx}>
                      <td className="code-line-num">{idx + 1}</td>
                      <td className="code-line-text">{line || ' '}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
