import React from 'react';
import { Paperclip, FileText } from 'lucide-react';

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
          title="Choose files, photos, or documents to send"
        >
          <Paperclip size={18} />
          <span>Send Files</span>
        </button>

        <button
          type="button"
          className="action-btn action-btn-secondary"
          onClick={onOpenSendText}
          title="Send a text note, link, or clipboard snippet"
        >
          <FileText size={18} />
          <span>Send Text</span>
        </button>
      </div>
    </footer>
  );
};

