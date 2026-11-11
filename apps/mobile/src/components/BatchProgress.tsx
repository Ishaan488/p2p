import React from 'react';
import { Pause, Play, X } from './icons';
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

/** Summary strip shown while several files are moving at once. */
export const BatchProgress: React.FC<BatchProgressProps> = ({
  activeCount, totalCount, sentBytes, totalBytes, speed, eta, isPaused, onPauseAll, onResumeAll, onCancelAll,
}) => {
  if (totalCount <= 1) return null;
  const percent = totalBytes > 0 ? Math.min(100, Math.max(0, (sentBytes / totalBytes) * 100)) : 0;
  const pct = Math.round(percent);

  return (
    <div className="batch" role="status" aria-live="polite">
      <div className="batch-top">
        <div className="batch-text">
          <span className="batch-title">
            {isPaused ? 'Paused' : 'Transferring'} · {activeCount > 0 ? `${activeCount} of ${totalCount}` : `${totalCount} queued`}
          </span>
          <span className="batch-sub">
            {formatBytes(sentBytes)} of {formatBytes(totalBytes)}
            {speed > 0 && !isPaused ? ` · ${formatSpeed(speed)}` : ''}
            {eta && !isPaused ? ` · ${eta}` : ''}
          </span>
        </div>
        {isPaused ? (
          <button type="button" className="icon-btn" onClick={onResumeAll} aria-label="Resume all"><Play size={18} /></button>
        ) : (
          <button type="button" className="icon-btn" onClick={onPauseAll} aria-label="Pause all"><Pause size={18} /></button>
        )}
        <button type="button" className="icon-btn" onClick={onCancelAll} aria-label="Cancel all"><X size={18} /></button>
      </div>
      <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`Batch progress ${pct}%`}>
        <div className="progress-fill" style={{ transform: `scaleX(${percent / 100})`, opacity: isPaused ? 0.5 : 1 }} />
      </div>
    </div>
  );
};
