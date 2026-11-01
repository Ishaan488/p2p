import React, { useState, useEffect, useRef } from 'react';
import { Send, X, Clipboard as ClipboardIcon, Check, FileText, CornerDownLeft, RotateCcw } from 'lucide-react';
import { Clipboard } from '@capacitor/clipboard';
import { backButtonManager } from '../lib/backButton';

export interface SendTextModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSend: (text: string) => void;
}

export const SendTextModal: React.FC<SendTextModalProps> = ({
  isOpen,
  onClose,
  onSend
}) => {
  const [text, setText] = useState('');
  const [hasPasted, setHasPasted] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-focus textarea when sheet opens & register Android back button + Esc key
  useEffect(() => {
    if (!isOpen) return;

    setText('');
    setHasPasted(false);

    // Auto focus with a small delay for sheet slide-up animation
    const timer = setTimeout(() => {
      textareaRef.current?.focus();
    }, 140);

    const unregister = backButtonManager.push(() => {
      onClose();
      return true;
    });

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      clearTimeout(timer);
      unregister();
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handlePaste = async () => {
    try {
      const { value } = await Clipboard.read();
      if (value) {
        setText((prev) => (prev ? `${prev}\n${value}` : value));
        triggerPastedFeedback();
        return;
      }
    } catch {
      // Fallback to browser clipboard API
      if (navigator.clipboard?.readText) {
        try {
          const val = await navigator.clipboard.readText();
          if (val) {
            setText((prev) => (prev ? `${prev}\n${val}` : val));
            triggerPastedFeedback();
            return;
          }
        } catch {
          // Clipboard read denied or not available
        }
      }
    }
  };

  const triggerPastedFeedback = () => {
    setHasPasted(true);
    setTimeout(() => {
      setHasPasted(false);
    }, 1800);
  };

  const handleClear = () => {
    setText('');
    textareaRef.current?.focus();
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const trimmedText = text.trim();
  const charCount = text.length;
  const wordCount = trimmedText ? trimmedText.split(/\s+/).length : 0;
  const lineCount = trimmedText ? trimmedText.split('\n').length : 0;

  return (
    <div
      className="sheet-backdrop p2p-sendtext-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="sendtext-title"
    >
      <div
        className="sheet-container p2p-sendtext-container"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-drag-handle" />

        <div className="sheet-header">
          <div className="sheet-header-left">
            <div className="sheet-icon-badge p2p-sendtext-badge">
              <FileText size={18} strokeWidth={2} />
            </div>
            <div>
              <h3 id="sendtext-title" className="sheet-title">Send Text or Link</h3>
              <p className="sheet-subtitle">Instant encrypted transfer to desktop</p>
            </div>
          </div>
          <button
            type="button"
            className="sheet-close-btn p2p-touch-target"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="sheet-body p2p-sendtext-body">
          <div className="textarea-container p2p-textarea-wrapper">
            <textarea
              ref={textareaRef}
              className="sheet-textarea p2p-styled-textarea"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type or paste text, URLs, code snippets, or notes..."
              rows={5}
              aria-label="Text message content"
            />
            {trimmedText.length > 0 && (
              <button
                type="button"
                className="p2p-textarea-clear-btn p2p-touch-target"
                onClick={handleClear}
                title="Clear text"
                aria-label="Clear text"
              >
                <RotateCcw size={14} />
              </button>
            )}
          </div>

          <div className="sheet-meta-row p2p-sendtext-meta">
            <button
              type="button"
              className={`sheet-paste-btn p2p-paste-action ${hasPasted ? 'p2p-paste-success' : ''}`}
              onClick={handlePaste}
              aria-label="Paste from clipboard"
            >
              {hasPasted ? (
                <>
                  <Check size={14} strokeWidth={2.5} />
                  <span>Pasted!</span>
                </>
              ) : (
                <>
                  <ClipboardIcon size={14} strokeWidth={2} />
                  <span>Paste from clipboard</span>
                </>
              )}
            </button>

            <div className="p2p-counter-pill" title={`${lineCount} lines`}>
              <span className="p2p-counter-words">
                {wordCount} {wordCount === 1 ? 'word' : 'words'}
              </span>
              <span className="p2p-counter-dot">•</span>
              <span className="p2p-counter-chars">{charCount} chars</span>
            </div>
          </div>

          <div className="p2p-shortcut-hint">
            <CornerDownLeft size={12} className="p2p-hint-icon" />
            <span>Tip: Press <strong>Ctrl + Enter</strong> to send</span>
          </div>

          <div className="sheet-actions p2p-sendtext-actions">
            <button
              type="button"
              className="sheet-btn sheet-btn-secondary p2p-action-btn"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="sheet-btn sheet-btn-primary p2p-action-btn p2p-btn-send"
              disabled={!trimmedText}
            >
              <Send size={15} strokeWidth={2} />
              <span>Send to Desktop</span>
            </button>
          </div>
        </form>
      </div>

      <style>{`
        .p2p-sendtext-backdrop {
          position: fixed;
          inset: 0;
          background: var(--backdrop-scrim);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          z-index: 100;
          display: flex;
          align-items: flex-end;
          justify-content: center;
        }

        .p2p-sendtext-container {
          width: 100%;
          max-width: 560px;
          background: var(--surface-elevated);
          border-top: 1px solid var(--border-strong);
          border-radius: var(--radius-lg) var(--radius-lg) 0 0;
          padding: 0.85rem 1.25rem;
          padding-bottom: calc(1.25rem + env(safe-area-inset-bottom));
          display: flex;
          flex-direction: column;
          gap: 0.85rem;
          box-shadow: var(--shadow-lg);
          animation: p2pSheetSlideUp 240ms var(--ease-spring);
        }

        @keyframes p2pSheetSlideUp {
          from {
            transform: translateY(100%);
          }
          to {
            transform: translateY(0);
          }
        }

        .p2p-sendtext-badge {
          background: var(--accent-subtle);
          color: var(--accent);
          border: 1px solid var(--accent-border);
        }

        .p2p-touch-target {
          min-width: 44px;
          min-height: 44px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }

        .p2p-sendtext-body {
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
        }

        .p2p-textarea-wrapper {
          position: relative;
          width: 100%;
        }

        .p2p-styled-textarea {
          width: 100%;
          background: var(--surface-secondary);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-md);
          color: var(--text-primary);
          font-family: var(--font-sans);
          font-size: 0.92rem;
          line-height: 1.5;
          padding: 0.85rem 2.5rem 0.85rem 0.85rem;
          resize: vertical;
          min-height: 130px;
          outline: none;
          transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
        }

        .p2p-styled-textarea:focus {
          border-color: var(--accent);
          box-shadow: 0 0 0 3px var(--accent-subtle);
        }

        .p2p-textarea-clear-btn {
          position: absolute;
          top: 6px;
          right: 6px;
          background: var(--surface-hover);
          border: 1px solid var(--border-subtle);
          color: var(--text-tertiary);
          border-radius: var(--radius-full);
          width: 32px;
          height: 32px;
          min-width: 32px;
          min-height: 32px;
          cursor: pointer;
          transition: color var(--transition-fast), background var(--transition-fast);
        }

        .p2p-textarea-clear-btn:hover {
          color: var(--text-primary);
          background: var(--surface-elevated);
        }

        .p2p-sendtext-meta {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 0.5rem;
          flex-wrap: wrap;
        }

        .p2p-paste-action {
          display: inline-flex;
          align-items: center;
          gap: 0.45rem;
          background: var(--surface-secondary);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-full);
          padding: 0 0.85rem;
          min-height: 40px;
          color: var(--text-primary);
          font-size: 0.78rem;
          font-weight: 600;
          cursor: pointer;
          transition: background var(--transition-fast), border-color var(--transition-fast), color var(--transition-fast);
        }

        .p2p-paste-action:hover {
          background: var(--surface-hover);
          border-color: var(--border-strong);
        }

        .p2p-paste-success {
          background: var(--success-subtle);
          color: var(--success);
          border-color: var(--success-border);
        }

        .p2p-counter-pill {
          display: inline-flex;
          align-items: center;
          gap: 0.35rem;
          padding: 0.35rem 0.75rem;
          border-radius: var(--radius-full);
          background: var(--surface-secondary);
          border: 1px solid var(--border-subtle);
          font-size: 0.72rem;
          font-variant-numeric: tabular-nums;
          color: var(--text-secondary);
        }

        .p2p-counter-words {
          font-weight: 600;
          color: var(--text-primary);
        }

        .p2p-counter-dot {
          color: var(--text-tertiary);
          font-size: 0.65rem;
        }

        .p2p-counter-chars {
          color: var(--text-tertiary);
        }

        .p2p-shortcut-hint {
          display: flex;
          align-items: center;
          gap: 0.4rem;
          font-size: 0.71rem;
          color: var(--text-tertiary);
          padding-left: 0.2rem;
        }

        .p2p-hint-icon {
          opacity: 0.7;
        }

        .p2p-sendtext-actions {
          display: flex;
          gap: 0.65rem;
          margin-top: 0.25rem;
        }

        .p2p-action-btn {
          flex: 1;
          min-height: 44px;
          border-radius: var(--radius-full);
          font-size: 0.88rem;
          font-weight: 600;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 0.45rem;
          transition: background var(--transition-fast), opacity var(--transition-fast), transform var(--transition-fast);
          border: 1px solid transparent;
        }

        .p2p-action-btn:active {
          transform: scale(0.985);
        }

        .p2p-btn-send {
          background: var(--btn-primary-bg);
          color: var(--btn-primary-text);
        }

        .p2p-btn-send:hover:not(:disabled) {
          background: var(--btn-primary-hover);
        }

        .p2p-btn-send:disabled {
          opacity: 0.38;
          cursor: not-allowed;
          transform: none;
        }

        @media (max-width: 360px) {
          .p2p-sendtext-container {
            padding: 0.75rem 0.95rem;
          }
          .p2p-sendtext-meta {
            flex-direction: column;
            align-items: flex-start;
          }
          .p2p-counter-pill {
            align-self: flex-end;
          }
        }
      `}</style>
    </div>
  );
};
