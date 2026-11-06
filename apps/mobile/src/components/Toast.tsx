import React from 'react';

export interface ToastMessage {
  id: string;
  text: string;
  type?: 'info' | 'success' | 'warning' | 'error';
  action?: {
    label: string;
    onClick: () => void;
  };
}

interface ToastProps {
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
}

export const ToastContainer: React.FC<ToastProps> = ({ toasts, onDismiss }) => {
  return (
    <div className="toast-container" aria-live="polite" aria-atomic="false">
      {toasts.map((toast) => {
        const isAlert = toast.type === 'warning' || toast.type === 'error';
        return (
          <div
            key={toast.id}
            role={isAlert ? 'alert' : 'status'}
            className={`toast-item toast-${toast.type === 'error' ? 'warning' : toast.type || 'info'}`}
            onClick={() => onDismiss(toast.id)}
          >
            <span>{toast.text}</span>
            {toast.action && (
              <button
                type="button"
                className="toast-action-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  toast.action?.onClick();
                  onDismiss(toast.id);
                }}
              >
                {toast.action.label}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
};
