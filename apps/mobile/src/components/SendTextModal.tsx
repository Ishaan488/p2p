import React, { useState, useEffect, useRef } from 'react';
import { Send, X, Clipboard as ClipboardIcon, FileText } from 'lucide-react';
import { Clipboard } from '@capacitor/clipboard';
import { backButtonManager } from '../lib/backButton';

interface SendTextModalProps {
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Focus textarea when modal opens & register Android back button
  useEffect(() => {
    if (!isOpen) return;
    setText('');
    const timer = setTimeout(() => {
      textareaRef.current?.focus();
    }, 120);

    const unregister = backButtonManager.push(() => {
      onClose();
      return true;
    });

    return () => {
      clearTimeout(timer);
      unregister();
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handlePaste = async () => {
    try {
      const { value } = await Clipboard.read();
      if (value) {
        setText(prev => (prev ? `${prev}\n${value}` : value));
      }
    } catch {
      if (navigator.clipboard?.readText) {
        try {
          const val = await navigator.clipboard.readText();
          if (val) setText(prev => (prev ? `${prev}\n${val}` : val));
        } catch {}
      }
    }
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

  const charCount = text.length;
  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;

  return (
    <div className="sheet-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="sheet-container" onClick={e => e.stopPropagation()}>
        <div className="sheet-drag-handle" />

        <div className="sheet-header">
          <div className="sheet-header-left">
            <div className="sheet-icon-badge">
              <FileText size={18} />
            </div>
            <div>
              <h3 className="sheet-title">Send Text or Link</h3>
              <p className="sheet-subtitle">Encrypted instant transfer to desktop</p>
            </div>
          </div>
          <button
            type="button"
            className="sheet-close-btn"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="sheet-body">
          <div className="textarea-container">
            <textarea
              ref={textareaRef}
              className="sheet-textarea"
              value={text}
              onChange={e => setText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type or paste text, URLs, notes, or code..."
              rows={5}
            />
          </div>

          <div className="sheet-meta-row">
            <button
              type="button"
              className="sheet-paste-btn"
              onClick={handlePaste}
            >
              <ClipboardIcon size={14} />
              <span>Paste from clipboard</span>
            </button>

            <span className="sheet-counter">
              {wordCount} {wordCount === 1 ? 'word' : 'words'} • {charCount} chars
            </span>
          </div>

          <div className="sheet-actions">
            <button
              type="button"
              className="sheet-btn sheet-btn-secondary"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="sheet-btn sheet-btn-primary"
              disabled={!text.trim()}
            >
              <Send size={15} />
              <span>Send to Desktop</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

