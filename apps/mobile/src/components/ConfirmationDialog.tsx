import React, { useEffect } from 'react';
import { AlertTriangle, Trash2, Unlink, X } from 'lucide-react';
import { backButtonManager } from '../lib/backButton';

interface ConfirmationDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'warning' | 'primary';
  icon?: 'trash' | 'unlink' | 'warning';
  onConfirm: () => void;
  onCancel: () => void;
}

export const ConfirmationDialog: React.FC<ConfirmationDialogProps> = ({
  isOpen,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'primary',
  icon = 'warning',
  onConfirm,
  onCancel
}) => {
  // Integrate with Android hardware back button and Esc key
  useEffect(() => {
    if (!isOpen) return;
    const unregister = backButtonManager.push(() => {
      onCancel();
      return true;
    });
    return unregister;
  }, [isOpen, onCancel]);

  if (!isOpen) return null;

  return (
    <div className="dialog-backdrop" onClick={onCancel} role="dialog" aria-modal="true">
      <div className="dialog-card" onClick={e => e.stopPropagation()}>
        <div className="dialog-header">
          <div className={`dialog-icon-badge ${variant}`}>
            {icon === 'trash' && <Trash2 size={20} />}
            {icon === 'unlink' && <Unlink size={20} />}
            {icon === 'warning' && <AlertTriangle size={20} />}
          </div>
          <button
            type="button"
            className="dialog-close-btn"
            onClick={onCancel}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <h3 className="dialog-title">{title}</h3>
        <p className="dialog-message">{message}</p>

        <div className="dialog-actions">
          <button
            type="button"
            className="dialog-btn dialog-btn-secondary"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`dialog-btn dialog-btn-${variant}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

