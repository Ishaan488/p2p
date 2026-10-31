import React, { useState } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Copy,
  Check,
  Download,
  Trash2,
  Pause,
  Play,
  X,
  ExternalLink,
  Eye,
  Package,
  File as FileIcon,
  FileArchive,
  FileCode,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  Music,
  Video as VideoIcon
} from 'lucide-react';
import { formatBytes, formatSpeed, MediaKind } from '../lib/telemetry';
import { AudioPlayer } from './AudioPlayer';
import { PdfViewer } from './PdfViewer';
import { CodeViewer } from './CodeViewer';

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
    totalSize: number;
    totalChunks: number;
    chunkSize: number;
    isDownloading?: boolean;
    progress?: number;
    blobUrl?: string;
    thumbnailUrl?: string;
    status?: string;
    speed?: number;
    eta?: string;
    error?: string;
    mediaKind?: MediaKind;
    snippet?: string;
    fullContent?: string;
    totalLines?: number;
    isPendingApproval?: boolean;
  };
  sender: 'me' | 'other';
  timestamp: number;
  isClipboard?: boolean;
  isPending?: boolean;
}

interface TransferCardProps {
  item: TransferItem;
  isDeleting: boolean;
  onCopy: (text: string) => void;
  onDownload: (id: string, file: NonNullable<TransferItem['file']>, saveToDisk: boolean) => void;
  onDelete: (id: string) => void;
  onOpenMedia: (payload: OpenMediaPayload) => void;
  onAcceptApproval: (id: string, file: NonNullable<TransferItem['file']>) => void;
  onAlwaysTrustApproval: (id: string, file: NonNullable<TransferItem['file']>) => void;
  onRejectApproval: (id: string) => void;
  onPauseUpload: (id: string) => void;
  onResumeUpload: (id: string) => void;
  onCancelUpload: (id: string, transferId: string) => void;
  onToast: (text: string, type?: 'info' | 'success' | 'warning') => void;
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

export const TransferCard: React.FC<TransferCardProps> = ({
  item,
  isDeleting,
  onCopy,
  onDownload,
  onDelete,
  onOpenMedia,
  onAcceptApproval,
  onAlwaysTrustApproval,
  onRejectApproval,
  onPauseUpload,
  onResumeUpload,
  onCancelUpload,
  onToast
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [justCopied, setJustCopied] = useState(false);

  const isSent = item.sender === 'me';
  const file = item.file;

  const isImageFile = file && (
    file.mediaKind === 'image' ||
    /\.(jpg|jpeg|png|gif|webp|svg|bmp|heic|avif)$/i.test(file.filename)
  );
  const isVideoFile = file && (
    file.mediaKind === 'video' ||
    /\.(mp4|mkv|mov|webm|avi|m4v|3gp)$/i.test(file.filename)
  );

  const hasVisualMedia = (isImageFile || isVideoFile) && (file?.blobUrl || file?.thumbnailUrl);
  const hasRichEmbed =
    (file?.blobUrl && (file.mediaKind === 'audio' || file.mediaKind === 'pdf')) ||
    !!file?.snippet;

  const isTextLong = !!item.text && item.text.length > 240;
  const displayText = isTextLong && !isExpanded && item.text
    ? `${item.text.slice(0, 240)}...`
    : (item.text || '');

  const detectedUrl = extractFirstUrl(item.text);
  const fileExt = file ? getFileExtension(file.filename) : '';
  const timeStr = formatCardTime(item.timestamp);

  const handleCopyClick = () => {
    if (!item.text) return;
    onCopy(item.text);
    setJustCopied(true);
    setTimeout(() => setJustCopied(false), 1800);
  };

  // Render Direction Badge inline
  const renderDirectionMeta = (extraText?: string) => (
    <div className="meta-inline-row">
      <span className={`dir-badge ${isSent ? 'sent' : 'received'}`}>
        {isSent ? <ArrowUpRight size={11} strokeWidth={2.5} /> : <ArrowDownLeft size={11} strokeWidth={2.5} />}
        <span>{isSent ? 'Sent' : 'Received'}</span>
      </span>
      {extraText && (
        <>
          <span className="meta-dot">·</span>
          <span className="meta-mono">{extraText}</span>
        </>
      )}
      <span className="meta-dot">·</span>
      <span className="meta-time">{timeStr}</span>
      {item.isPending && (
        <>
          <span className="meta-dot">·</span>
          <span className="meta-queued">Queued</span>
        </>
      )}
    </div>
  );

  return (
    <article className={`transfer-card ${isDeleting ? 'deleting' : ''}`}>
      {/* =========================================================
          1. TEXT OR LINK SNIPPET CARD (Single Clean Surface)
          ========================================================= */}
      {item.text && !file && (
        <div className="text-transfer-layout">
          <div className="text-body-wrap">
            <p className="card-text-body">{displayText}</p>
            {isTextLong && (
              <button
                type="button"
                className="card-text-expand-btn"
                onClick={() => setIsExpanded(e => !e)}
              >
                {isExpanded ? 'Show less' : 'Read full text'}
              </button>
            )}
          </div>

          <div className="card-unified-footer">
            {renderDirectionMeta(detectedUrl ? 'Link' : `${item.text.length} chars`)}

            <div className="card-actions-group">
              {detectedUrl && (
                <a
                  href={detectedUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="card-pill-btn"
                  title="Open link"
                >
                  <ExternalLink size={13} />
                  <span>Open</span>
                </a>
              )}
              <button
                type="button"
                className="card-pill-btn card-pill-primary"
                onClick={handleCopyClick}
              >
                {justCopied ? <Check size={13} /> : <Copy size={13} />}
                <span>{justCopied ? 'Copied' : 'Copy'}</span>
              </button>
              <button
                type="button"
                className="card-icon-only-btn"
                onClick={() => onDelete(item.id)}
                title="Remove"
                aria-label="Remove"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =========================================================
          2. INCOMING FILE APPROVAL PROMPT
          ========================================================= */}
      {file && file.isPendingApproval && (
        <div className="approval-layout">
          <div className="file-row-main">
            <div className="file-squircle-icon">
              {getFileIcon(file.filename, file.mediaKind)}
            </div>
            <div className="file-row-text">
              <span className="file-row-title">{file.filename}</span>
              {renderDirectionMeta(`${formatBytes(file.totalSize)} · ${fileExt}`)}
            </div>
          </div>
          <div className="approval-actions">
            <button
              type="button"
              className="approval-btn approval-reject"
              onClick={() => onRejectApproval(item.id)}
            >
              Decline
            </button>
            <button
              type="button"
              className="approval-btn approval-accept"
              onClick={() => onAcceptApproval(item.id, file)}
            >
              Accept
            </button>
            <button
              type="button"
              className="approval-btn approval-trust"
              onClick={() => onAlwaysTrustApproval(item.id, file)}
            >
              Always Trust
            </button>
          </div>
        </div>
      )}

      {/* =========================================================
          3. VISUAL MEDIA CARD (Image / Video Preview + Unified Footer)
          ========================================================= */}
      {file && !file.isPendingApproval && hasVisualMedia && (
        <div className="media-transfer-layout">
          {isImageFile ? (
            <div
              className="media-stage-box"
              onClick={() => {
                const src = file.blobUrl || file.thumbnailUrl!;
                onOpenMedia({
                  type: 'image',
                  src,
                  filename: file.filename,
                  fileSize: file.totalSize,
                  onDownload: () => onDownload(item.id, file, true)
                });
              }}
            >
              <img
                src={file.blobUrl || file.thumbnailUrl}
                alt={file.filename}
                loading="lazy"
              />
            </div>
          ) : (
            <div
              className="media-stage-box video-stage"
              onClick={() => {
                if (file.blobUrl) {
                  onOpenMedia({
                    type: 'video',
                    src: file.blobUrl,
                    filename: file.filename,
                    fileSize: file.totalSize,
                    onDownload: () => onDownload(item.id, file, true)
                  });
                } else {
                  onDownload(item.id, file, false);
                }
              }}
            >
              {file.thumbnailUrl ? (
                <img
                  src={file.thumbnailUrl}
                  alt={file.filename}
                  className="video-thumbnail-img"
                />
              ) : (
                <div className="video-placeholder-backdrop">
                  <VideoIcon size={28} />
                </div>
              )}
              <div className="video-play-overlay">
                <div className="video-play-circle">
                  <Play size={20} fill="currentColor" style={{ marginLeft: '2px' }} />
                </div>
              </div>
            </div>
          )}

          <div className="media-unified-footer">
            <div className="media-footer-info">
              <span className="file-row-title" title={file.filename}>{file.filename}</span>
              {renderDirectionMeta(`${formatBytes(file.totalSize)} · ${fileExt}`)}
            </div>

            <div className="card-actions-group">
              <button
                type="button"
                className="card-pill-btn card-pill-primary"
                onClick={() => onDownload(item.id, file, true)}
                disabled={file.isDownloading}
              >
                <Download size={13} />
                <span>{file.isDownloading ? `${Math.round(file.progress || 0)}%` : 'Save'}</span>
              </button>
              <button
                type="button"
                className="card-icon-only-btn"
                onClick={() => onDelete(item.id)}
                title="Remove"
                aria-label="Remove"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =========================================================
          4. RICH EMBEDDED VIEWERS (Audio / PDF / Code)
          ========================================================= */}
      {file && !file.isPendingApproval && !hasVisualMedia && hasRichEmbed && (
        <div className="embed-transfer-layout">
          <div className="card-unified-footer embed-header-bar">
            {renderDirectionMeta(`${formatBytes(file.totalSize)} · ${fileExt}`)}
            <div className="card-actions-group">
              <button
                type="button"
                className="card-pill-btn card-pill-primary"
                onClick={() => onDownload(item.id, file, true)}
                disabled={file.isDownloading}
              >
                <Download size={13} />
                <span>{file.isDownloading ? `${Math.round(file.progress || 0)}%` : 'Save'}</span>
              </button>
              <button
                type="button"
                className="card-icon-only-btn"
                onClick={() => onDelete(item.id)}
                title="Remove"
                aria-label="Remove"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>

          {file.blobUrl && file.mediaKind === 'audio' ? (
            <AudioPlayer
              src={file.blobUrl}
              filename={file.filename}
              fileSize={file.totalSize}
            />
          ) : file.blobUrl && file.mediaKind === 'pdf' ? (
            <PdfViewer
              src={file.blobUrl}
              filename={file.filename}
              fileSize={file.totalSize}
            />
          ) : file.snippet ? (
            <CodeViewer
              filename={file.filename}
              snippet={file.snippet}
              fullContent={file.fullContent}
              totalLines={file.totalLines}
              fileSize={file.totalSize}
              onCopyNotice={onToast}
            />
          ) : null}
        </div>
      )}

      {/* =========================================================
          5. SINGLE-ROW FILE CARD (Apple Files / Google Files Style)
          No nested boxes! Clean icon + title/meta + actions
          ========================================================= */}
      {file && !file.isPendingApproval && !hasVisualMedia && !hasRichEmbed && (
        <div className="file-single-row-layout">
          <div className="file-row-main">
            <div className="file-squircle-icon">
              {getFileIcon(file.filename, file.mediaKind)}
            </div>
            <div className="file-row-text">
              <span className="file-row-title" title={file.filename}>
                {file.filename}
              </span>
              {renderDirectionMeta(`${formatBytes(file.totalSize)} · ${fileExt}`)}
            </div>
          </div>

          <div className="card-actions-group">
            {(isImageFile ||
              isVideoFile ||
              file.mediaKind === 'audio' ||
              file.mediaKind === 'code' ||
              file.mediaKind === 'pdf') &&
              !file.blobUrl && (
                <button
                  type="button"
                  className="card-pill-btn"
                  onClick={() => onDownload(item.id, file, false)}
                  disabled={file.isDownloading}
                  title="Preview file"
                >
                  <Eye size={13} />
                  <span>Preview</span>
                </button>
              )}

            <button
              type="button"
              className="card-pill-btn card-pill-primary"
              onClick={() => onDownload(item.id, file, true)}
              disabled={file.isDownloading}
              title="Save to device"
            >
              <Download size={13} />
              <span>{file.isDownloading ? `${Math.round(file.progress || 0)}%` : 'Save'}</span>
            </button>

            <button
              type="button"
              className="card-icon-only-btn"
              onClick={() => onDelete(item.id)}
              title="Remove"
              aria-label="Remove"
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      )}

      {/* =========================================================
          6. LIVE PROGRESS BAR (Active Upload or Download)
          ========================================================= */}
      {file && !file.isPendingApproval && !isSent && file.isDownloading && (
        <div className="progress-container">
          <div className="progress-bar-track">
            <div
              className="progress-bar-indicator"
              style={{ width: `${Math.min(100, file.progress || 0)}%` }}
            />
          </div>
          <div className="progress-meta-row">
            <span className="progress-status-label">
              Receiving & decrypting · {Math.round(file.progress || 0)}%
            </span>
          </div>
        </div>
      )}

      {file && !file.isPendingApproval && isSent && file.status && file.status !== 'done' && (
        <div className="progress-container">
          {file.status !== 'canceled' && (
            <div className="progress-bar-track">
              <div
                className="progress-bar-indicator"
                style={{ width: `${Math.min(100, file.progress || 0)}%` }}
              />
            </div>
          )}

          <div className="progress-meta-row">
            <span className="progress-status-label">
              {file.status === 'uploading' && (
                <>
                  {Math.round(file.progress || 0)}% · {formatSpeed(file.speed || 0)}
                  {file.eta ? ` · ${file.eta}` : ''}
                </>
              )}
              {file.status === 'queued' && 'Queued...'}
              {file.status === 'paused' && 'Paused'}
              {file.status === 'interrupted' && 'Interrupted — auto-resumes on reconnect'}
              {file.status === 'canceled' && 'Canceled'}
              {file.status === 'error' && (file.error || 'Transfer failed')}
            </span>

            <div className="progress-controls">
              {file.status === 'uploading' && (
                <button
                  type="button"
                  className="progress-ctrl-btn"
                  onClick={() => onPauseUpload(item.id)}
                  title="Pause"
                  aria-label="Pause"
                >
                  <Pause size={11} />
                </button>
              )}
              {file.status === 'paused' && (
                <button
                  type="button"
                  className="progress-ctrl-btn"
                  onClick={() => onResumeUpload(item.id)}
                  title="Resume"
                  aria-label="Resume"
                >
                  <Play size={11} />
                </button>
              )}
              {file.status !== 'canceled' && file.status !== 'done' && (
                <button
                  type="button"
                  className="progress-ctrl-btn progress-cancel"
                  onClick={() => onCancelUpload(item.id, file.transferId)}
                  title="Cancel"
                  aria-label="Cancel"
                >
                  <X size={11} />
                </button>
              )}
            </div>
          </div>

          {file.error && (
            <div className="transfer-error-notice">
              {file.error}
            </div>
          )}
        </div>
      )}
    </article>
  );
};
