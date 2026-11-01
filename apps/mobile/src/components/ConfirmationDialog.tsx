import React, { useEffect } from 'react';
import { AlertTriangle, Trash2, Unlink, X } from 'lucide-react';
import { backButtonManager } from '../lib/backButton';

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
  // Support Android physical back button and Esc key
  useEffect(() => {
    if (!isOpen) return;

    const unregister = backButtonManager.push(() => {
      onCancel();
      return true;
    });

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      unregister();
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onCancel]);

  if (!isOpen) return null;

  return (
    <div
      className="dialog-backdrop"
      onClick={onCancel}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="dialog-title"
      aria-describedby="dialog-desc"
    >
      <div
        className="dialog-card p2p-confirmation-dialog-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-header">
          <div className={`dialog-icon-badge ${variant}`}>
            {icon === 'trash' && <Trash2 size={20} strokeWidth={2.2} />}
            {icon === 'unlink' && <Unlink size={20} strokeWidth={2.2} />}
            {icon === 'warning' && <AlertTriangle size={20} strokeWidth={2.2} />}
          </div>
          <button
            type="button"
            className="dialog-close-btn"
            onClick={onCancel}
            aria-label="Close dialog"
          >
            <X size={18} />
          </button>
        </div>

        <div className="dialog-body">
          <h3 id="dialog-title" className="dialog-title">
            {title}
          </h3>
          <p id="dialog-desc" className="dialog-message">
            {message}
          </p>
        </div>

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
            autoFocus
          >
            {confirmLabel}
          </button>
        </div>
      </div>

      <style>{`
        .p2p-confirmation-dialog-card {
          width: 100%;
          max-width: 380px;
          background: var(--surface-elevated);
          border: 1px solid var(--border-strong);
          border-radius: var(--radius-lg);
          padding: 1.25rem;
          display: flex;
          flex-direction: column;
          gap: 0.9rem;
          box-shadow: var(--shadow-lg);
          animation: p2pDialogPop 190ms var(--ease-spring);
        }

        @keyframes p2pDialogPop {
          from {
            opacity: 0;
            transform: scale(0.92) translateY(6px);
          }
          to {
            opacity: 1;
            transform: scale(1) translateY(0);
          }
        }

        .dialog-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .dialog-icon-badge {
          width: 44px;
          height: 44px;
          border-radius: 12px;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          transition: transform var(--transition-fast);
        }

        .dialog-icon-badge.danger {
          background: var(--error-subtle);
          color: var(--error);
          border: 1px solid var(--error-border);
        }

        .dialog-icon-badge.warning {
          background: var(--warning-subtle);
          color: var(--warning);
          border: 1px solid var(--warning-border);
        }

        .dialog-icon-badge.primary {
          background: var(--accent-subtle);
          color: var(--accent);
          border: 1px solid var(--accent-border);
        }

        .dialog-close-btn {
          background: transparent;
          border: none;
          color: var(--text-secondary);
          width: 44px;
          height: 44px;
          border-radius: var(--radius-full);
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition: background var(--transition-fast), color var(--transition-fast);
        }

        .dialog-close-btn:hover {
          background: var(--surface-hover);
          color: var(--text-primary);
        }

        .dialog-body {
          display: flex;
          flex-direction: column;
          gap: 0.35rem;
        }

        .dialog-title {
          font-size: 1.05rem;
          font-weight: 600;
          letter-spacing: -0.015em;
          color: var(--text-primary);
          line-height: 1.3;
        }

        .dialog-message {
          font-size: 0.835rem;
          line-height: 1.48;
          color: var(--text-secondary);
        }

        .dialog-actions {
          display: flex;
          gap: 0.65rem;
          margin-top: 0.35rem;
        }

        .dialog-btn {
          flex: 1;
          min-height: 44px;
          padding: 0 1rem;
          border-radius: var(--radius-full);
          font-size: 0.86rem;
          font-weight: 600;
          letter-spacing: -0.01em;
          cursor: pointer;
          border: 1px solid transparent;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          transition: background var(--transition-fast), transform var(--transition-fast), opacity var(--transition-fast);
        }

        .dialog-btn:active {
          transform: scale(0.98);
        }

        .dialog-btn-secondary {
          background: var(--surface-secondary);
          border-color: var(--border-subtle);
          color: var(--text-primary);
        }

        .dialog-btn-secondary:hover {
          background: var(--surface-hover);
        }

        .dialog-btn-danger {
          background: var(--error);
          color: #FFFFFF;
        }

        .dialog-btn-danger:hover {
          filter: brightness(1.08);
        }

        .dialog-btn-warning {
          background: var(--warning);
          color: #17161D;
        }

        .dialog-btn-warning:hover {
          filter: brightness(1.08);
        }

        .dialog-btn-primary {
          background: var(--btn-primary-bg);
          color: var(--btn-primary-text);
        }

        .dialog-btn-primary:hover {
          background: var(--btn-primary-hover);
        }

        @media (max-width: 360px) {
          .p2p-confirmation-dialog-card {
            padding: 1rem;
          }
          .dialog-title {
            font-size: 0.98rem;
          }
          .dialog-message {
            font-size: 0.8rem;
          }
        }
      `}</style>
    </div>
  );
};
