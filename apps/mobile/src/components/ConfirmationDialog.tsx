import React from 'react';
import { Sheet } from './Sheet';

export interface ConfirmationDialogProps {
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

/** Confirmation as a compact bottom sheet: the consequence in plain words, one clear action. */
export const ConfirmationDialog: React.FC<ConfirmationDialogProps> = ({
  isOpen, title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', variant = 'primary', onConfirm, onCancel,
}) => (
  <Sheet
    open={isOpen}
    onClose={onCancel}
    title={title}
    description={message}
    closable={false}
    stackedFooter
    footer={
      <>
        <button type="button" className={`btn btn-block ${variant === 'danger' ? 'btn-danger' : 'btn-primary'}`} onClick={onConfirm}>
          {confirmLabel}
        </button>
        <button type="button" className="btn btn-secondary btn-block" onClick={onCancel}>{cancelLabel}</button>
      </>
    }
  >
    {null}
  </Sheet>
);
