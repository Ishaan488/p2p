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
  onCopyNotice?: (msg: string) => void;
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
      onCopyNotice(`Copied ${filename} to clipboard`);
    }
    setTimeout(() => setCopied(false), 2000);
  };

  const lines = snippet.split('\n');
  const langLabel = getLanguageLabel(filename);

  return (
    <>
      <div className="code-viewer-card">
        <div className="code-viewer-header">
          <div className="code-viewer-left">
            <Code2 size={16} className="code-icon" />
            <span className="code-filename" title={filename}>{filename}</span>
            <span className="code-lang-pill">{langLabel}</span>
            {fileSize !== undefined && (
              <span className="code-size-pill">{formatBytes(fileSize)}</span>
            )}
          </div>

          <div className="code-viewer-actions">
            <button
              className="code-action-btn"
              onClick={handleCopy}
              title="Copy all code to clipboard"
            >
              {copied ? <Check size={14} color="var(--success-color)" /> : <Copy size={14} />}
              <span>{copied ? 'Copied' : 'Copy'}</span>
            </button>

            {fullContent && totalLines && totalLines > lines.length && (
              <button
                className="code-action-btn"
                onClick={() => setIsModalOpen(true)}
                title="Expand full file"
              >
                <Maximize2 size={13} />
                <span>Full</span>
              </button>
            )}

            {onDownload && (
              <button className="icon-btn" onClick={onDownload} title="Download Source File">
                <Download size={15} />
              </button>
            )}
          </div>
        </div>

        <div className="code-snippet-box">
          <table className="code-table">
            <tbody>
              {lines.map((line, idx) => (
                <tr key={idx}>
                  <td className="code-line-num">{idx + 1}</td>
                  <td className="code-line-text">{line || ' '}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {totalLines && totalLines > lines.length && (
            <div className="code-more-indicator" onClick={() => setIsModalOpen(true)}>
              <span>+ {totalLines - lines.length} more lines • Click to view all</span>
            </div>
          )}
        </div>
      </div>

      {isModalOpen && (
        <div className="code-modal-overlay" onClick={() => setIsModalOpen(false)}>
          <div className="code-modal-content" onClick={e => e.stopPropagation()}>
            <div className="code-modal-header">
              <div className="code-modal-title">
                <Code2 size={18} />
                <span>{filename}</span>
                <span className="code-lang-pill">{langLabel}</span>
                {totalLines && <span className="code-size-pill">{totalLines} lines</span>}
              </div>

              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <button className="code-action-btn" onClick={handleCopy}>
                  {copied ? <Check size={14} color="var(--success-color)" /> : <Copy size={14} />}
                  <span>{copied ? 'Copied' : 'Copy All'}</span>
                </button>
                {onDownload && (
                  <button className="icon-btn" onClick={onDownload} title="Download">
                    <Download size={18} />
                  </button>
                )}
                <button className="icon-btn" onClick={() => setIsModalOpen(false)} title="Close (Esc)">
                  <X size={20} />
                </button>
              </div>
            </div>

            <div className="code-modal-body">
              <pre className="code-modal-pre">
                <code>{fullContent || snippet}</code>
              </pre>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
