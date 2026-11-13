import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowDownLeft, ArrowUpRight, RotateCcw, Copy, Check, Download, Trash2, Pause, Play, X, ExternalLink, Package,
  File as FileIcon, FileArchive, FileCode, FileSpreadsheet, FileText, Image as ImageIcon, Music, Video as VideoIcon,
  MoreVertical, Share2,
} from './icons';
import { formatBytes, formatSpeed, MediaKind } from '../lib/telemetry';
import { AudioPlayer } from './AudioPlayer';
import { PdfViewer } from './PdfViewer';
import { CodeViewer } from './CodeViewer';
import { Sheet } from './Sheet';

export interface OpenMediaPayload {
  type: 'image' | 'video';
  src: string;
  filename: string;
  fileSize?: number;
  onDownload?: () => void;
}

export interface TransferItem {
  id: string;
  text?: string;
  file?: {
    filename: string;
    transferId: string;
    /** Key of the stored preview copy; shared by every recipient of one sent file. */
    cacheKey?: string;
    totalSize: number;
    totalChunks: number;
    chunkSize: number;
    isDownloading?: boolean;
    progress?: number;
    blobUrl?: string;
    thumbnailUrl?: string;
    status?: string;
    priority?: 'high' | 'normal' | 'low';
    speed?: number;
    eta?: string;
    error?: string;
    mediaKind?: MediaKind;
    snippet?: string;
    fullContent?: string;
    totalLines?: number;
    isPendingApproval?: boolean;
    saveToDisk?: boolean;
    savedBytes?: number;
  };
  sender: 'me' | 'other';
  timestamp: number;
  isClipboard?: boolean;
  isPending?: boolean;
  peerId?: string;
  peerName?: string;
  peerIds?: string[];
}

export interface TransferCardProps {
  item: TransferItem;
  isDeleting: boolean;
  onCopy: (text: string) => void;
  onDownload: (id: string, file: NonNullable<TransferItem['file']>, saveToDisk: boolean) => void;
  onDelete: (id: string) => void;
  onOpenMedia: (payload: OpenMediaPayload) => void;
  onAcceptApproval: (id: string, file: NonNullable<TransferItem['file']>) => void;
  onAlwaysTrustApproval: (id: string, file: NonNullable<TransferItem['file']>) => void;
  onRejectApproval: (id: string, file?: TransferItem['file']) => void;
  onPauseUpload: (id: string) => void;
  onResumeUpload: (id: string) => void;
  onCancelUpload: (id: string, transferId: string) => void;
  onTogglePriority?: (id: string) => void;
  onToast: (text: string, type?: 'info' | 'success' | 'warning') => void;
  peerLabel?: string;
  selectionMode?: boolean;
  isSelected?: boolean;
  onToggleSelect?: (id: string) => void;
  onLongPressSelect?: (id: string) => void;
  onSaveText?: (id: string, text: string) => void;
}

const SWIPE_THRESHOLD = 76;
const LONG_PRESS_MS = 450;
const MOVE_SLOP = 8;

function applyRubberBand(dx: number): number {
  const sign = dx < 0 ? -1 : 1;
  const abs = Math.abs(dx);
  if (abs <= 96) return dx;
  return sign * (96 + Math.min(40, (abs - 96) * 0.35));
}

function getFileExtension(filename: string): string {
  const parts = filename.split('.');
  if (parts.length < 2) return 'FILE';
  const ext = parts.pop()?.toUpperCase() || 'FILE';
  return ext.length <= 6 ? ext : 'FILE';
}

function getFileIcon(filename: string, mediaKind?: MediaKind) {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  if (mediaKind === 'image' || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'heic', 'avif'].includes(ext)) {
    return <ImageIcon size={20} />;
  }
  if (mediaKind === 'video' || ['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v', '3gp'].includes(ext)) {
    return <VideoIcon size={20} />;
  }
  if (mediaKind === 'audio' || ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'opus'].includes(ext)) {
    return <Music size={20} />;
  }
  if (mediaKind === 'code' || ['js', 'ts', 'tsx', 'jsx', 'py', 'go', 'rs', 'c', 'cpp', 'h', 'java', 'kt', 'swift', 'html', 'css', 'json', 'yaml', 'yml', 'toml', 'xml', 'sql', 'sh'].includes(ext)) {
    return <FileCode size={20} />;
  }
  if (['apk', 'aab', 'dmg', 'exe', 'msi', 'deb', 'rpm', 'iso'].includes(ext)) {
    return <Package size={20} />;
  }
  if (['zip', 'tar', 'gz', 'tgz', 'rar', '7z', 'bz2', 'xz'].includes(ext)) {
    return <FileArchive size={20} />;
  }
  if (['xls', 'xlsx', 'csv', 'tsv', 'ods'].includes(ext)) {
    return <FileSpreadsheet size={20} />;
  }
  if (['pdf', 'doc', 'docx', 'txt', 'md', 'rtf', 'ppt', 'pptx'].includes(ext) || mediaKind === 'pdf') {
    return <FileText size={20} />;
  }
  return <FileIcon size={20} />;
}

function formatCardTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function extractFirstUrl(text?: string): string | null {
  if (!text) return null;
  const match = text.match(/https?:\/\/[^\s<>"']+/i);
  return match ? match[0] : null;
}

function statusText(file: NonNullable<TransferItem['file']>): string {
  const pct = Math.round(file.progress || 0);
  const extra = `${file.speed ? ` · ${formatSpeed(file.speed)}` : ''}${file.eta ? ` · ${file.eta}` : ''}`;
  if (file.status === 'saving') return `Saving to Downloads · ${pct}%`;
  if (file.isDownloading) return `Receiving · ${pct}%${extra}`;
  switch (file.status) {
    case 'uploading': return `Sending · ${pct}%${extra}`;
    case 'queued': return 'Waiting in line';
    case 'paused': return `Paused · ${pct}%`;
    case 'interrupted': return 'Interrupted · resumes when reconnected';
    case 'canceled': return 'Canceled';
    case 'error': return file.error || 'Transfer failed';
    default: return file.error || 'Transfer failed';
  }
}

export const TransferCard: React.FC<TransferCardProps> = ({
  item, isDeleting, onCopy, onDownload, onDelete, onOpenMedia, onAcceptApproval, onAlwaysTrustApproval,
  onRejectApproval, onPauseUpload, onResumeUpload, onCancelUpload, onTogglePriority: _onTogglePriority, onToast, peerLabel,
  selectionMode = false, isSelected = false, onToggleSelect, onLongPressSelect, onSaveText,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [justCopied, setJustCopied] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const [swipeX, setSwipeX] = useState(0);
  const [isSnapping, setIsSnapping] = useState(false);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const axisLockRef = useRef<'none' | 'horizontal' | 'vertical'>('none');
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armedRef = useRef<'save' | 'remove' | null>(null);
  const suppressClickRef = useRef(false);

  const clearLongPress = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  useEffect(() => () => clearLongPress(), []);

  // Reset swipe if selection mode activates
  useEffect(() => {
    if (selectionMode && swipeX !== 0) {
      setIsSnapping(true);
      setSwipeX(0);
    }
  }, [selectionMode]);

  const isSent = item.sender === 'me';
  const file = item.file;
  const canSwipeActions = !detailsOpen && !file?.isPendingApproval;

  const isImageFile = !!file && (file.mediaKind === 'image' || /\.(jpg|jpeg|png|gif|webp|svg|bmp|heic|avif)$/i.test(file.filename));
  const isVideoFile = !!file && (file.mediaKind === 'video' || /\.(mp4|mkv|mov|webm|avi|m4v|3gp)$/i.test(file.filename));
  const thumbSrc = isVideoFile ? file?.thumbnailUrl : (file?.blobUrl || file?.thumbnailUrl);
  const hasVisualMedia = !imageFailed && ((isImageFile && !!thumbSrc) || (isVideoFile && !!thumbSrc && !!file?.blobUrl));
  const hasRichEmbed = (!!file?.blobUrl && (file.mediaKind === 'audio' || file.mediaKind === 'pdf')) || !!file?.snippet;

  const isTextLong = !!item.text && item.text.length > 180;
  const displayText = isTextLong && !isExpanded && item.text ? `${item.text.slice(0, 180)}…` : (item.text || '');
  const detectedUrl = extractFirstUrl(item.text);
  const fileExt = file ? getFileExtension(file.filename) : '';
  const timeStr = formatCardTime(item.timestamp);

  const inFlight = !!file && !file.isPendingApproval && (file.isDownloading || file.status === 'saving' || (!!file.status && file.status !== 'done'));
  const failed = !!file && (file.status === 'error' || file.status === 'interrupted' || (!!file.error && !file.isDownloading));
  const canResume = !!file && (file.status === 'paused' || file.status === 'error' || file.status === 'interrupted');

  const triggerSave = () => {
    if (file) {
      onDownload(item.id, file, true);
    } else if (item.text && onSaveText) {
      onSaveText(item.id, item.text);
    }
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    if (!canSwipeActions || e.touches.length > 1) return;
    const t = e.touches[0];
    touchStartRef.current = { x: t.clientX, y: t.clientY };
    axisLockRef.current = 'none';
    armedRef.current = null;
    setIsSnapping(false);

    if (!selectionMode && onLongPressSelect) {
      clearLongPress();
      longPressTimerRef.current = setTimeout(() => {
        longPressTimerRef.current = null;
        try { navigator.vibrate?.(16); } catch {}
        suppressClickRef.current = true;
        setTimeout(() => { suppressClickRef.current = false; }, 350);
        onLongPressSelect(item.id);
      }, LONG_PRESS_MS);
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!touchStartRef.current || e.touches.length > 1) return;
    const t = e.touches[0];
    const dx = t.clientX - touchStartRef.current.x;
    const dy = t.clientY - touchStartRef.current.y;

    if (Math.abs(dx) > MOVE_SLOP || Math.abs(dy) > MOVE_SLOP) {
      clearLongPress();
    }

    if (selectionMode || !canSwipeActions) return;

    if (axisLockRef.current === 'none') {
      if (Math.abs(dx) < MOVE_SLOP && Math.abs(dy) < MOVE_SLOP) return;
      if (Math.abs(dy) > Math.abs(dx) * 1.1) {
        axisLockRef.current = 'vertical';
        return;
      }
      axisLockRef.current = 'horizontal';
    }

    if (axisLockRef.current !== 'horizontal') return;

    const clamped = applyRubberBand(dx);
    setSwipeX(clamped);

    if (clamped >= SWIPE_THRESHOLD && armedRef.current !== 'save') {
      armedRef.current = 'save';
      try { navigator.vibrate?.(10); } catch {}
    } else if (clamped <= -SWIPE_THRESHOLD && armedRef.current !== 'remove') {
      armedRef.current = 'remove';
      try { navigator.vibrate?.(10); } catch {}
    } else if (Math.abs(clamped) < SWIPE_THRESHOLD && armedRef.current !== null) {
      armedRef.current = null;
    }
  };

  const handleTouchEnd = () => {
    clearLongPress();
    if (!touchStartRef.current) return;
    const wasHorizontal = axisLockRef.current === 'horizontal';
    const finalX = swipeX;
    touchStartRef.current = null;
    axisLockRef.current = 'none';
    armedRef.current = null;

    if (wasHorizontal) {
      suppressClickRef.current = true;
      setTimeout(() => { suppressClickRef.current = false; }, 160);
      setIsSnapping(true);
      setSwipeX(0);
      if (finalX >= SWIPE_THRESHOLD) {
        triggerSave();
      } else if (finalX <= -SWIPE_THRESHOLD) {
        onDelete(item.id);
      }
    }
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || selectionMode || !onLongPressSelect || !canSwipeActions) return;
    clearLongPress();
    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null;
      suppressClickRef.current = true;
      setTimeout(() => { suppressClickRef.current = false; }, 350);
      onLongPressSelect(item.id);
    }, LONG_PRESS_MS);
  };

  const handleCardClickCapture = (e: React.MouseEvent) => {
    if (suppressClickRef.current) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (selectionMode && onToggleSelect) {
      e.preventDefault();
      e.stopPropagation();
      onToggleSelect(item.id);
    }
  };

  const handleCopy = () => {
    if (!item.text) return;
    onCopy(item.text);
    setJustCopied(true);
    setTimeout(() => setJustCopied(false), 1600);
  };

  const handleShare = async () => {
    setDetailsOpen(false);
    if (item.text && navigator.share) {
      try { await navigator.share({ text: item.text }); } catch { /* dismissed */ }
      return;
    }
    if (file?.blobUrl && navigator.share) {
      try {
        const blob = await (await fetch(file.blobUrl)).blob();
        const f = new File([blob], file.filename, { type: blob.type });
        if (navigator.canShare && navigator.canShare({ files: [f] })) {
          await navigator.share({ files: [f], title: file.filename });
          return;
        }
      } catch { /* fall through */ }
    }
    if (item.text) { handleCopy(); onToast('Text copied to clipboard', 'info'); }
    else onToast('Sharing isn’t available here', 'warning');
  };

  const openMedia = () => {
    if (!file) return;
    onOpenMedia({
      type: isVideoFile ? 'video' : 'image',
      src: (file.blobUrl || file.thumbnailUrl)!,
      filename: file.filename,
      fileSize: file.totalSize,
      onDownload: () => onDownload(item.id, file, true),
    });
  };

  const meta = (extra?: string) => (
    <span className="feed-meta">
      {isSent ? <ArrowUpRight size={12} /> : <ArrowDownLeft size={12} />}
      {isSent ? 'Sent' : 'Received'}
      {peerLabel ? ` ${isSent ? 'to' : 'from'} ${peerLabel}` : ''}
      {extra ? ` · ${extra}` : ''}
      {` · ${timeStr}`}
      {item.isPending ? ' · Queued' : ''}
    </span>
  );

  const menuButton = (
    <button type="button" className="icon-btn feed-more" onClick={() => setDetailsOpen(true)} aria-label="Details and actions">
      <MoreVertical size={18} />
    </button>
  );

  const swipeDir = swipeX > 0 ? 'save' : swipeX < 0 ? 'remove' : null;
  const swipeProgress = Math.min(1, Math.abs(swipeX) / SWIPE_THRESHOLD);
  const isArmed = Math.abs(swipeX) >= SWIPE_THRESHOLD;

  return (
    <>
      <div
        className={`swipe-wrapper${isDeleting ? ' is-deleting' : ''}`}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
      onMouseDown={handleMouseDown}
      onMouseUp={clearLongPress}
      onMouseLeave={clearLongPress}
      onClickCapture={handleCardClickCapture}
    >
      {swipeDir && (
        <div className={`swipe-rail is-${swipeDir}${isArmed ? ' is-armed' : ''}`} aria-hidden="true">
          <span
            className="swipe-action"
            style={{
              opacity: Math.max(0.25, swipeProgress),
              transform: `scale(${isArmed ? 1.08 : 0.8 + swipeProgress * 0.2})`,
            }}
          >
            {swipeDir === 'save' ? (
              <>
                <Download size={19} />
                <span>Save to Downloads</span>
              </>
            ) : (
              <>
                <span>Remove</span>
                <Trash2 size={19} />
              </>
            )}
          </span>
        </div>
      )}
      <div
        className={`swipe-content${isSnapping ? ' is-snapping' : ''}`}
        style={swipeX !== 0 ? { transform: `translate3d(${swipeX}px, 0, 0)` } : undefined}
      >
        <article className={`feed-item${isDeleting ? ' deleting' : ''}${selectionMode ? ' is-selecting' : ''}${isSelected ? ' is-selected' : ''}`}>
          {selectionMode && (
            <span className={`selection-check${isSelected ? ' is-checked' : ''}`} aria-hidden="true">
              {isSelected && <Check size={14} />}
            </span>
          )}
          <div className="feed-item-body">
      {/* Text */}
      {item.text && !file && (
        <div className="feed-text">
          <div className="feed-text-top">
            <p className="feed-text-body" onClick={handleCopy}>{displayText}</p>
            {menuButton}
          </div>
          {isTextLong && (
            <button type="button" className="link-btn" onClick={() => setIsExpanded(v => !v)}>
              {isExpanded ? 'Show less' : 'Show more'}
            </button>
          )}
          <div className="feed-foot">
            {meta(detectedUrl ? 'Link' : undefined)}
            <span className="feed-actions">
              {detectedUrl && (
                <a href={detectedUrl} target="_blank" rel="noreferrer" className="link-btn"><ExternalLink size={13} /> Open</a>
              )}
              <button type="button" className={`link-btn${justCopied ? ' is-done' : ''}`} onClick={handleCopy} aria-label="Copy text">
                {justCopied ? <Check size={13} /> : <Copy size={13} />} {justCopied ? 'Copied' : 'Copy'}
              </button>
            </span>
          </div>
        </div>
      )}

      {/* Incoming file needs approval */}
      {file && file.isPendingApproval && (
        <div className="feed-approval">
          <div className="feed-file">
            <span className="feed-icon">{getFileIcon(file.filename, file.mediaKind)}</span>
            <div className="feed-file-main">
              <span className="feed-file-name" title={file.filename}>{file.filename}</span>
              <span className="feed-meta">Incoming · {formatBytes(file.totalSize)} · {fileExt}{peerLabel ? ` · from ${peerLabel}` : ''}</span>
            </div>
          </div>
          <div className="feed-approval-actions">
            <button type="button" className="btn btn-primary btn-sm" onClick={() => onAcceptApproval(item.id, file)}>Accept</button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => onRejectApproval(item.id, file)}>Decline</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onAlwaysTrustApproval(item.id, file)}>Always accept</button>
          </div>
        </div>
      )}

      {/* Image / video */}
      {file && !file.isPendingApproval && hasVisualMedia && (
        <div className="feed-file">
          <div
            className="feed-thumb"
            role="button"
            tabIndex={0}
            aria-label={`View ${file.filename}`}
            onClick={openMedia}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMedia(); } }}
          >
            <img src={thumbSrc} alt="" loading="lazy" onError={() => setImageFailed(true)} />
            {isVideoFile && <span className="feed-thumb-play"><Play size={14} fill="currentColor" /></span>}
          </div>
          <div className="feed-file-main">
            <span className="feed-file-name" title={file.filename}>{file.filename}</span>
            <span className="feed-meta">{formatBytes(file.totalSize)} · {fileExt}</span>
            {meta()}
          </div>
          {menuButton}
        </div>
      )}

      {/* Audio / PDF / code */}
      {file && !file.isPendingApproval && !hasVisualMedia && hasRichEmbed && (
        <div className="feed-embed">
          <div className="feed-file">
            <div className="feed-file-main">
              <span className="feed-file-name" title={file.filename}>{file.filename}</span>
              {meta(`${formatBytes(file.totalSize)} · ${fileExt}`)}
            </div>
            {menuButton}
          </div>
          <div className="feed-embed-body">
            {file.blobUrl && file.mediaKind === 'audio' ? (
              <AudioPlayer src={file.blobUrl} filename={file.filename} fileSize={file.totalSize} onDownload={() => onDownload(item.id, file, true)} />
            ) : file.blobUrl && file.mediaKind === 'pdf' ? (
              <PdfViewer src={file.blobUrl} filename={file.filename} fileSize={file.totalSize} onDownload={() => onDownload(item.id, file, true)} />
            ) : file.snippet ? (
              <CodeViewer filename={file.filename} snippet={file.snippet} fullContent={file.fullContent} totalLines={file.totalLines} fileSize={file.totalSize} onDownload={() => onDownload(item.id, file, true)} onCopyNotice={onToast} />
            ) : null}
          </div>
        </div>
      )}

      {/* Other files */}
      {file && !file.isPendingApproval && !hasVisualMedia && !hasRichEmbed && (
        <div className="feed-file">
          <span className="feed-icon">{getFileIcon(file.filename, file.mediaKind)}</span>
          <div className="feed-file-main">
            <span className="feed-file-name" title={file.filename}>{file.filename}</span>
            <span className="feed-meta">{formatBytes(file.totalSize)} · {fileExt}</span>
            {meta()}
          </div>
          {menuButton}
        </div>
      )}

      {/* Progress */}
      {file && !file.isPendingApproval && inFlight && (
        <div className="feed-progress">
          {file.status !== 'canceled' && (
            <div
              className={`progress${file.status === 'queued' ? ' is-queued' : ''}${failed ? ' is-error' : ''}`}
              role="progressbar"
              aria-valuenow={Math.round(file.progress || 0)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className="progress-fill" style={file.status === 'queued' ? undefined : { transform: `scaleX(${Math.max(0, Math.min(1, (file.progress || 0) / 100))})` }} />
            </div>
          )}
          <div className="feed-progress-row">
            <span className={`feed-status${failed ? ' is-error' : ''}`}>{statusText(file)}</span>
            <span className="feed-actions">
              {file.status === 'uploading' && <button type="button" className="icon-btn icon-btn-sm" onClick={() => onPauseUpload(item.id)} aria-label="Pause"><Pause size={15} /></button>}
              {canResume && <button type="button" className="icon-btn icon-btn-sm" onClick={() => onResumeUpload(item.id)} aria-label="Resume"><Play size={15} /></button>}
              {file.status !== 'canceled' && file.status !== 'done' && (
                <button type="button" className="icon-btn icon-btn-sm" onClick={() => onCancelUpload(item.id, file.transferId)} aria-label="Cancel"><X size={15} /></button>
              )}
            </span>
          </div>
        </div>
      )}

          </div>
        </article>
      </div>
    </div>

      {/* Transfer details */}
      <Sheet open={detailsOpen} onClose={() => setDetailsOpen(false)} title={file ? file.filename : 'Message'} flush>
        <div className="detail-list">
          <div className="row"><span className="row-main"><span className="row-title">{isSent ? 'Sent' : 'Received'}</span></span><span className="row-value">{new Date(item.timestamp).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</span></div>
          {peerLabel && <div className="row"><span className="row-main"><span className="row-title">{isSent ? 'To' : 'From'}</span></span><span className="row-value">{peerLabel}</span></div>}
          {file && <div className="row"><span className="row-main"><span className="row-title">Size</span></span><span className="row-value">{formatBytes(file.totalSize)}</span></div>}
          {file && <div className="row"><span className="row-main"><span className="row-title">Status</span></span><span className="row-value">{inFlight ? statusText(file) : 'Complete'}</span></div>}
          {item.text && <div className="row"><span className="row-main"><span className="row-title">Length</span></span><span className="row-value">{item.text.length} characters</span></div>}
        </div>
        <ul className="rows detail-actions">
          {item.text && !file && (
            <li><button type="button" className="row" onClick={() => { handleCopy(); setDetailsOpen(false); }}><Copy size={20} className="row-icon" /><span className="row-main"><span className="row-title">Copy</span></span></button></li>
          )}
          {file && (isImageFile || isVideoFile) && (file.blobUrl || file.thumbnailUrl) && (
            <li><button type="button" className="row" onClick={() => { setDetailsOpen(false); openMedia(); }}><Play size={20} className="row-icon" /><span className="row-main"><span className="row-title">{isVideoFile ? 'Play video' : 'View image'}</span></span></button></li>
          )}
          {file && !file.isPendingApproval && (
            <li><button type="button" className="row" onClick={() => { setDetailsOpen(false); onDownload(item.id, file, true); }}><Download size={20} className="row-icon" /><span className="row-main"><span className="row-title">Save to Downloads</span></span></button></li>
          )}
          {item.text && !file && onSaveText && (
            <li><button type="button" className="row" onClick={() => { setDetailsOpen(false); onSaveText(item.id, item.text!); }}><Download size={20} className="row-icon" /><span className="row-main"><span className="row-title">Save to Downloads</span></span></button></li>
          )}
          {file && canResume && (
            <li><button type="button" className="row" onClick={() => { setDetailsOpen(false); onResumeUpload(item.id); }}><RotateCcw size={20} className="row-icon" /><span className="row-main"><span className="row-title">Resume transfer</span></span></button></li>
          )}
          <li><button type="button" className="row" onClick={handleShare}><Share2 size={20} className="row-icon" /><span className="row-main"><span className="row-title">Share</span></span></button></li>
          {onLongPressSelect && (
            <li><button type="button" className="row" onClick={() => { setDetailsOpen(false); onLongPressSelect(item.id); }}><Check size={20} className="row-icon" /><span className="row-main"><span className="row-title">Select</span></span></button></li>
          )}
          <li><button type="button" className="row is-destructive" onClick={() => { setDetailsOpen(false); onDelete(item.id); }}><Trash2 size={20} className="row-icon" /><span className="row-main"><span className="row-title">Remove from list</span></span></button></li>
        </ul>
      </Sheet>
    </>
  );
};

export default TransferCard;
