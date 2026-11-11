import React from 'react';
import { AlertCircle, AlertTriangle } from './icons';

/** On/off control with switch semantics and a 44px touch target. */
export const Switch: React.FC<{ checked: boolean; label: string; onChange: (next: boolean) => void; disabled?: boolean }> = ({
  checked, label, onChange, disabled,
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    disabled={disabled}
    className={`switch${checked ? ' on' : ''}`}
    onClick={() => onChange(!checked)}
  >
    <span className="switch-knob" />
  </button>
);

/** Centered empty / error / recovery state. */
export const StateView: React.FC<{
  icon?: React.ReactNode;
  title: string;
  body?: string;
  tone?: 'neutral' | 'error' | 'warning';
  children?: React.ReactNode;
}> = ({ icon, title, body, tone = 'neutral', children }) => (
  <div className={`state${tone === 'error' ? ' is-error' : tone === 'warning' ? ' is-warning' : ''}`} role={tone === 'error' ? 'alert' : 'status'}>
    {icon && <div className="state-icon">{icon}</div>}
    <h3 className="state-title">{title}</h3>
    {body && <p className="state-body">{body}</p>}
    {children && <div className="state-actions">{children}</div>}
  </div>
);

/** Non-blocking inline notice with optional actions. */
export const Notice: React.FC<{
  tone?: 'neutral' | 'error' | 'warning';
  title?: string;
  children?: React.ReactNode;
  actions?: React.ReactNode;
}> = ({ tone = 'neutral', title, children, actions }) => (
  <div className={`notice${tone === 'error' ? ' is-error' : tone === 'warning' ? ' is-warning' : ''}`} role={tone === 'error' ? 'alert' : 'status'}>
    <span className="notice-icon">{tone === 'warning' ? <AlertTriangle size={16} /> : <AlertCircle size={16} />}</span>
    <div className="notice-main">
      {title && <div className="notice-title">{title}</div>}
      <div>{children}</div>
      {actions && <div className="notice-actions">{actions}</div>}
    </div>
  </div>
);

/** Device initials-free avatar: a calm square with an icon. */
export const IconTile: React.FC<{ children: React.ReactNode; size?: number }> = ({ children, size = 40 }) => (
  <span className="icon-tile" style={{ width: size, height: size }} aria-hidden="true">{children}</span>
);
