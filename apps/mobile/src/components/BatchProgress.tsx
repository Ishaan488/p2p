import React from 'react';
import { Layers, Pause, Play, X, Zap, Clock } from 'lucide-react';
import { formatBytes, formatSpeed } from '../lib/telemetry';

export interface BatchProgressProps {
  activeCount: number;
  totalCount: number;
  sentBytes: number;
  totalBytes: number;
  speed: number;
  eta: string;
  isPaused?: boolean;
  onPauseAll: () => void;
  onResumeAll: () => void;
  onCancelAll: () => void;
}

export const BatchProgress: React.FC<BatchProgressProps> = ({
  activeCount,
  totalCount,
  sentBytes,
  totalBytes,
  speed,
  eta,
  isPaused,
  onPauseAll,
  onResumeAll,
  onCancelAll
}) => {
  // Only display HUD if multiple items are queued or in flight
  if (totalCount <= 1) return null;

  const percent = totalBytes > 0 ? Math.min(100, Math.max(0, (sentBytes / totalBytes) * 100)) : 0;
  const roundedPercent = Math.round(percent);

  return (
    <div
      className="batch-hud batch-hud-root"
      role="status"
      aria-live="polite"
      aria-label="Batch transfer progress HUD"
    >
      <style>{`
        .batch-hud-root {
          background: var(--surface, #201E27);
          border: 1px solid var(--border-subtle, #383442);
          border-radius: var(--radius-lg, 14px);
          padding: 0.75rem 0.95rem;
          display: flex;
          flex-direction: column;
          gap: 0.6rem;
          box-shadow: 0 4px 18px rgba(0, 0, 0, 0.28);
          margin-bottom: 0.85rem;
          position: relative;
          overflow: hidden;
          user-select: none;
          box-sizing: border-box;
          transition: border-color 160ms ease, box-shadow 160ms ease;
        }

        .batch-hud-root:hover {
          border-color: var(--accent-border, rgba(169, 149, 213, 0.28));
        }

        /* 1. Header: Badge, Status Counter, Controls */
        .batch-hud-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 0.5rem;
        }

        .batch-hud-left {
          display: flex;
          align-items: center;
          gap: 0.45rem;
          min-width: 0;
          overflow: hidden;
        }

        .batch-badge {
          display: inline-flex;
          align-items: center;
          gap: 0.3rem;
          padding: 0.2rem 0.5rem;
          border-radius: 9999px;
          background: var(--accent-subtle, rgba(169, 149, 213, 0.12));
          border: 1px solid var(--accent-border, rgba(169, 149, 213, 0.24));
          font-size: 0.72rem;
          font-weight: 650;
          color: var(--accent, #A995D5);
          letter-spacing: -0.01em;
          flex-shrink: 0;
        }

        .batch-counter {
          font-size: 0.72rem;
          font-variant-numeric: tabular-nums;
          color: var(--text-secondary, #B1AABD);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .batch-paused-indicator {
          display: inline-flex;
          align-items: center;
          padding: 0.15rem 0.42rem;
          border-radius: 9999px;
          background: var(--warning-subtle, rgba(214, 183, 126, 0.12));
          border: 1px solid var(--warning-border, rgba(214, 183, 126, 0.24));
          color: var(--warning, #D6B77E);
          font-size: 0.68rem;
          font-weight: 600;
          margin-left: 0.2rem;
        }

        /* 2. Controls Row (Pause / Resume, Cancel) */
        .batch-hud-controls {
          display: flex;
          align-items: center;
          gap: 0.4rem;
          flex-shrink: 0;
        }

        .batch-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 0.3rem;
          height: 36px;
          min-height: 36px;
          min-width: 44px;
          padding: 0 0.65rem;
          background: var(--surface-secondary, #292633);
          border: 1px solid var(--border-subtle, #383442);
          border-radius: 9999px;
          color: var(--text-primary, #F0EDF5);
          font-size: 0.72rem;
          font-weight: 600;
          cursor: pointer;
          transition: background 140ms ease, border-color 140ms ease, transform 100ms ease;
          touch-action: manipulation;
          -webkit-tap-highlight-color: transparent;
          position: relative;
        }

        /* Ensures 44px effective touch target even if visual height is 36px */
        .batch-btn::before {
          content: '';
          position: absolute;
          inset: -4px;
        }

        .batch-btn:hover {
          background: var(--surface-hover, #383442);
          border-color: var(--accent-border, rgba(169, 149, 213, 0.28));
        }

        .batch-btn:active {
          transform: scale(0.96);
        }

        .batch-btn-resume {
          background: var(--accent-subtle, rgba(169, 149, 213, 0.16));
          border-color: var(--accent-border, rgba(169, 149, 213, 0.35));
          color: var(--accent, #A995D5);
        }

        .batch-btn-resume:hover {
          background: var(--accent-subtle, rgba(169, 149, 213, 0.24));
        }

        .batch-btn-cancel:hover {
          color: var(--error, #D98F96);
          background: var(--error-subtle, rgba(217, 143, 150, 0.12));
          border-color: var(--error-border, rgba(217, 143, 150, 0.25));
        }

        /* 3. Shimmer Progress Indicator Bar */
        .batch-progress-section {
          display: flex;
          align-items: center;
          gap: 0.6rem;
        }

        .shimmer-bar-container {
          flex: 1;
          height: 6px;
          background: var(--surface-secondary, #292633);
          border-radius: 9999px;
          overflow: hidden;
          position: relative;
        }

        .shimmer-bar-fill {
          height: 100%;
          border-radius: 9999px;
          background: linear-gradient(
            90deg,
            var(--accent, #A995D5) 0%,
            #C4B4E8 35%,
            var(--accent, #A995D5) 70%,
            #8A73B8 100%
          );
          background-size: 200% 100%;
          animation: batchProgressShimmer 2.4s linear infinite;
          transition: width 180ms ease-out;
        }

        .shimmer-bar-fill.paused {
          animation-play-state: paused;
          opacity: 0.65;
          filter: grayscale(0.25);
        }

        @keyframes batchProgressShimmer {
          0% {
            background-position: 200% 0;
          }
          100% {
            background-position: -200% 0;
          }
        }

        .batch-percent-badge {
          font-size: 0.76rem;
          font-weight: 700;
          font-variant-numeric: tabular-nums;
          color: var(--accent, #A995D5);
          min-width: 38px;
          text-align: right;
          flex-shrink: 0;
        }

        /* 4. Footer: Transferred / Total Bytes & Live Telemetry */
        .batch-hud-footer {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 0.5rem;
          font-size: 0.72rem;
          font-variant-numeric: tabular-nums;
          color: var(--text-secondary, #B1AABD);
        }

        .batch-stats {
          display: flex;
          align-items: center;
          gap: 0.25rem;
          white-space: nowrap;
        }

        .batch-stats-highlight {
          color: var(--text-primary, #F0EDF5);
          font-weight: 600;
        }

        .batch-telemetry {
          display: flex;
          align-items: center;
          gap: 0.55rem;
          flex-shrink: 0;
        }

        .batch-speed {
          display: inline-flex;
          align-items: center;
          gap: 0.24rem;
          color: var(--accent, #A995D5);
          font-weight: 600;
        }

        .batch-eta {
          display: inline-flex;
          align-items: center;
          gap: 0.22rem;
          color: var(--text-secondary, #B1AABD);
        }
      `}</style>

      {/* Top Header: Batch title, active transfer count & pause/cancel controls */}
      <div className="batch-hud-header">
        <div className="batch-hud-left">
          <div className="batch-badge">
            <Layers size={13} strokeWidth={2.4} aria-hidden="true" />
            <span>Batch Transfer</span>
          </div>
          <span className="batch-counter">
            {activeCount > 0 ? `${activeCount} of ${totalCount} active` : `${totalCount} files queued`}
          </span>
          {isPaused && <span className="batch-paused-indicator">Paused</span>}
        </div>

        <div className="batch-hud-controls">
          {isPaused ? (
            <button
              type="button"
              className="batch-btn batch-btn-resume"
              onClick={onResumeAll}
              title="Resume all active transfers"
              aria-label="Resume all transfers"
            >
              <Play size={13} strokeWidth={2.4} />
              <span>Resume</span>
            </button>
          ) : (
            <button
              type="button"
              className="batch-btn"
              onClick={onPauseAll}
              title="Pause all transfers in batch"
              aria-label="Pause all transfers"
            >
              <Pause size={13} strokeWidth={2.4} />
              <span>Pause</span>
            </button>
          )}

          <button
            type="button"
            className="batch-btn batch-btn-cancel"
            onClick={onCancelAll}
            title="Cancel all transfers in batch"
            aria-label="Cancel all transfers"
          >
            <X size={13} strokeWidth={2.4} />
            <span>Cancel</span>
          </button>
        </div>
      </div>

      {/* Middle Shimmer Progress Bar & Cumulative Percentage */}
      <div className="batch-progress-section">
        <div
          className="shimmer-bar-container"
          role="progressbar"
          aria-valuenow={roundedPercent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Batch progress: ${roundedPercent}%`}
        >
          <div
            className={`shimmer-bar-fill ${isPaused ? 'paused' : ''}`}
            style={{ width: `${percent}%` }}
          />
        </div>
        <span className="batch-percent-badge">{roundedPercent}%</span>
      </div>

      {/* Footer: Transferred / Total Bytes & Live Telemetry (Speed + ETA) */}
      <div className="batch-hud-footer">
        <div className="batch-stats">
          <span className="batch-stats-highlight">{formatBytes(sentBytes)}</span>
          <span>/</span>
          <span>{formatBytes(totalBytes)}</span>
        </div>

        <div className="batch-telemetry">
          {speed > 0 && (
            <span className="batch-speed" title="Live aggregate transfer speed">
              <Zap size={12} strokeWidth={2.4} aria-hidden="true" />
              <span>{formatSpeed(speed)}</span>
            </span>
          )}
          {eta && (
            <span className="batch-eta" title="Estimated time remaining">
              <Clock size={11} strokeWidth={2.2} aria-hidden="true" />
              <span>{eta}</span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
};
