import React from 'react';
import { Plus, FileText } from 'lucide-react';

interface TransferActionPanelProps {
  onOpenFilePicker: () => void;
  onOpenSendText: () => void;
}

export const TransferActionPanel: React.FC<TransferActionPanelProps> = ({
  onOpenFilePicker,
  onOpenSendText
}) => {
  return (
    <footer className="transfer-action-panel">
      <div className="action-panel-inner">
        <button
          type="button"
          className="action-btn action-btn-primary"
          onClick={onOpenFilePicker}
          title="Select files, photos, or videos to send"
        >
          <Plus size={18} strokeWidth={2.4} />
          <span>Send Files</span>
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
