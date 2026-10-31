import React, { useState } from 'react';
import { Plus, FileText, SlidersHorizontal, Image, Film, Music, FileSpreadsheet, FolderUp, ClipboardPaste } from 'lucide-react';

export type FileCategoryFilter = 'all' | 'image' | 'video' | 'audio' | 'docs' | 'folder';

interface TransferActionPanelProps {
  onOpenFilePicker: (accept?: string, isFolder?: boolean) => void;
  onOpenSendText: () => void;
  onQuickSendClipboard?: () => void;
}

export const TransferActionPanel: React.FC<TransferActionPanelProps> = ({
  onOpenFilePicker,
  onOpenSendText,
  onQuickSendClipboard
}) => {
  const [showCategories, setShowCategories] = useState(false);

  const handleCategoryPick = (accept?: string, isFolder?: boolean) => {
    setShowCategories(false);
    onOpenFilePicker(accept, isFolder);
  };

  return (
    <footer className="transfer-action-panel">
      {showCategories && (
        <div className="category-picker-strip" role="region" aria-label="Select by file category">
          <button
            type="button"
            className="category-chip"
            onClick={() => handleCategoryPick('image/*', false)}
          >
            <Image size={13} />
            <span>Photos</span>
          </button>
          <button
            type="button"
            className="category-chip"
            onClick={() => handleCategoryPick('video/*', false)}
          >
            <Film size={13} />
            <span>Videos</span>
          </button>
          <button
            type="button"
            className="category-chip"
            onClick={() => handleCategoryPick('audio/*', false)}
          >
            <Music size={13} />
            <span>Audio</span>
          </button>
          <button
            type="button"
            className="category-chip"
            onClick={() => handleCategoryPick('.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.csv,.json,.zip,.rar,.7z', false)}
          >
            <FileSpreadsheet size={13} />
            <span>Docs</span>
          </button>
          <button
            type="button"
            className="category-chip"
            onClick={() => handleCategoryPick(undefined, true)}
          >
            <FolderUp size={13} />
            <span>Folder</span>
          </button>
          {onQuickSendClipboard && (
            <button
              type="button"
              className="category-chip"
              onClick={() => {
                setShowCategories(false);
                onQuickSendClipboard();
              }}
            >
              <ClipboardPaste size={13} />
              <span>Paste & Send</span>
            </button>
          )}
        </div>
      )}

      <div className="action-panel-inner">
        <button
          type="button"
          className="action-btn action-btn-primary"
          onClick={() => onOpenFilePicker('*/*', false)}
          title="Select files, photos, or videos to send"
        >
          <Plus size={18} strokeWidth={2.4} />
          <span>Send Files</span>
        </button>

        <button
          type="button"
          className={`action-btn-filter ${showCategories ? 'active' : ''}`}
          onClick={() => setShowCategories(prev => !prev)}
          title="Filter by file category or send a folder"
          aria-label="Filter by file category or send a folder"
          aria-expanded={showCategories}
        >
          <SlidersHorizontal size={16} />
        </button>

        <button
          type="button"
          className="action-btn action-btn-secondary"
          onClick={onOpenSendText}
          title="Send text, URL, or clipboard snippet"
        >
          <FileText size={17} />
          <span>Send Text</span>
        </button>
      </div>
    </footer>
  );
};
