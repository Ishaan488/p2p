import React, { useState, useEffect, useRef } from 'react';
import { Send, Clipboard as ClipboardIcon, Check, X } from './icons';
import { Clipboard } from '@capacitor/clipboard';
import { Sheet } from './Sheet';

export interface SendTextModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSend: (text: string) => void;
  targetSummary?: string;
}

/** Send text or a link: one field, paste shortcut, and a single clear send action. */
export const SendTextModal: React.FC<SendTextModalProps> = ({ isOpen, onClose, onSend, targetSummary }) => {
  const [text, setText] = useState('');
  const [pasted, setPasted] = useState(false);
  const [pasteFailed, setPasteFailed] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    setText('');
    setPasted(false);
    setPasteFailed(false);
    const t = setTimeout(() => ref.current?.focus(), 260);
    return () => clearTimeout(t);
  }, [isOpen]);

  const append = (value: string) => {
    setText(prev => (prev ? `${prev}\n${value}` : value));
    setPasted(true);
    setPasteFailed(false);
    setTimeout(() => setPasted(false), 1600);
  };

  const paste = async () => {
    try {
      const { value } = await Clipboard.read();
      if (value) return append(value);
    } catch {
      try {
        const v = await navigator.clipboard?.readText?.();
        if (v) return append(v);
      } catch { /* denied */ }
    }
    setPasteFailed(true);
  };

  const trimmed = text.trim();
  const submit = () => {
    if (!trimmed) return;
    onSend(trimmed);
    onClose();
  };

  return (
    <Sheet
      open={isOpen}
      onClose={onClose}
      title="Send text or link"
      description={targetSummary ? `To ${targetSummary}` : 'Sent instantly and encrypted'}
      footer={
        <button type="button" className="btn btn-primary btn-block" onClick={submit} disabled={!trimmed}>
          <Send size={16} />
          {targetSummary ? `Send to ${targetSummary}` : 'Send'}
        </button>
      }
    >
      <div className="field">
        <div style={{ position: 'relative' }}>
          <textarea
            ref={ref}
            className="input"
            style={{ minHeight: 132, paddingRight: 44 }}
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); submit(); } }}
            placeholder="Type or paste text, a link or a note"
            rows={5}
            aria-label="Message"
          />
          {trimmed && (
            <button type="button" className="icon-btn" style={{ position: 'absolute', top: 2, right: 0 }} onClick={() => { setText(''); ref.current?.focus(); }} aria-label="Clear">
              <X size={18} />
            </button>
          )}
        </div>
        <div className="send-text-meta">
          <button type="button" className={`link-btn${pasted ? ' is-done' : ''}`} onClick={paste}>
            {pasted ? <Check size={14} /> : <ClipboardIcon size={14} />}
            {pasted ? 'Pasted' : 'Paste from clipboard'}
          </button>
          <span className="t-meta">{text.length} characters</span>
        </div>
        {pasteFailed && <span className="field-hint" role="status">Nothing to paste, or clipboard access was denied.</span>}
      </div>
    </Sheet>
  );
};
