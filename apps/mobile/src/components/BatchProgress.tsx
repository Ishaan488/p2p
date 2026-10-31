import React from 'react';
import { Layers, Pause, Play, X, Zap } from 'lucide-react';
import { formatBytes, formatSpeed } from '../lib/telemetry';

interface BatchProgressProps {
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
  if (totalCount <= 1) return null;

  const percent = totalBytes > 0 ? Math.min(100, (sentBytes / totalBytes) * 100) : 0;

  return (
    <div className="batch-hud">
      <div className="batch-hud-header">
        <div className="batch-hud-left">
          <div className="batch-badge">
            <Layers size={14} />
            <span>Batch Transfer</span>
          </div>
          <span className="batch-counter">
            {activeCount > 0 ? `${activeCount} in queue / ${totalCount} total` : `${totalCount} files`}
          </span>
        </div>

        <div className="batch-hud-controls">
          {isPaused ? (
            <button className="batch-btn" onClick={onResumeAll} title="Resume All">
              <Play size={14} />
              <span>Resume</span>
            </button>
          ) : (
            <button className="batch-btn" onClick={onPauseAll} title="Pause All">
              <Pause size={14} />
              <span>Pause</span>
            </button>
          )}
          <button className="batch-btn batch-btn-cancel" onClick={onCancelAll} title="Cancel All">
            <X size={14} />
            <span>Cancel</span>
          </button>
        </div>
      </div>

      <div className="shimmer-bar-container">
        <div
          className="shimmer-bar-fill"
          style={{ width: `${percent}%` }}
        />
      </div>

      <div className="batch-hud-footer">
        <div className="batch-stats">
          <span>{formatBytes(sentBytes)} / {formatBytes(totalBytes)} ({Math.round(percent)}%)</span>
        </div>
        <div className="batch-telemetry">
          {speed > 0 && (
            <span className="batch-speed">
              <Zap size={12} color="var(--accent-color)" />
              {formatSpeed(speed)}
            </span>
          )}
          <span className="batch-eta">{eta}</span>
        </div>
      </div>
    </div>
  );
};
