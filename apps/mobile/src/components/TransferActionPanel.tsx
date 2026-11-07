import React, { useState } from 'react';
import { Plus, Type, Image, FileUp, ClipboardPaste, Folder, ChevronRight, Users } from 'lucide-react';
import { Sheet } from './Sheet';

export interface TransferActionPanelProps {
  onOpenFilePicker: (accept?: string, isFolder?: boolean) => void;
  onOpenSendText: () => void;
  onQuickSendClipboard?: () => void;
  targetNames: string[];
  canPickTargets: boolean;
  onPickTargets: () => void;
}

/** "Send to …" summary shown above the composer buttons. */
function targetLine(names: string[]): string {
  if (names.length === 0) return 'No device selected';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} and ${names.length - 1} others`;
}

/**
 * Composer: a quiet dock with one primary action. Sources (photos, files, clipboard, folder)
 * live in the Send files sheet so the main screen stays uncluttered.
 */
export const TransferActionPanel: React.FC<TransferActionPanelProps> = ({
  onOpenFilePicker, onOpenSendText, onQuickSendClipboard, targetNames, canPickTargets, onPickTargets,
}) => {
  const [open, setOpen] = useState(false);
  const pick = (accept: string, folder = false) => { setOpen(false); onOpenFilePicker(accept, folder); };

  return (
    <footer className="composer" role="region" aria-label="Send">
      {targetNames.length > 0 && (
        canPickTargets ? (
          <button type="button" className="composer-targets" onClick={onPickTargets}>
            <Users size={14} />
            <span className="truncate">Sending to {targetLine(targetNames)}</span>
            <ChevronRight size={14} />
          </button>
        ) : (
          <div className="composer-targets is-static"><span className="truncate">Sending to {targetLine(targetNames)}</span></div>
        )
      )}
      <div className="composer-row">
        <button type="button" className="btn btn-primary composer-main" onClick={() => setOpen(true)} aria-label="Send files">
          <Plus size={18} /> Send files
        </button>
        <button type="button" className="btn btn-secondary composer-text" onClick={onOpenSendText} aria-label="Send text">
          <Type size={16} /> Text
        </button>
      </div>

      <Sheet open={open} onClose={() => setOpen(false)} title="Send files" flush>
        <ul className="rows">
          <li><button type="button" className="row" onClick={() => pick('image/*,video/*')}>
            <Image size={20} className="row-icon" />
            <span className="row-main"><span className="row-title">Photos and videos</span><span className="row-sub">From your gallery</span></span>
          </button></li>
          <li><button type="button" className="row" onClick={() => pick('*/*')}>
            <FileUp size={20} className="row-icon" />
            <span className="row-main"><span className="row-title">Files</span><span className="row-sub">Documents, downloads, archives</span></span>
          </button></li>
          <li><button type="button" className="row" onClick={() => pick('*/*', true)}>
            <Folder size={20} className="row-icon" />
            <span className="row-main"><span className="row-title">Folder</span><span className="row-sub">Everything inside a folder</span></span>
          </button></li>
          {onQuickSendClipboard && (
            <li><button type="button" className="row" onClick={() => { setOpen(false); onQuickSendClipboard(); }}>
              <ClipboardPaste size={20} className="row-icon" />
              <span className="row-main"><span className="row-title">Clipboard</span><span className="row-sub">Send what you last copied</span></span>
            </button></li>
          )}
        </ul>
      </Sheet>
    </footer>
  );
};

export default TransferActionPanel;
