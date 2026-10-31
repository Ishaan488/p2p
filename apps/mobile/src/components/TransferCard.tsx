import React, { useState } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Clock,
  Copy,
  Download,
  Trash2,
  ZoomIn,
  Pause,
  Play,
  X,
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
import { VideoPlayer } from './VideoPlayer';
import { PdfViewer } from './PdfViewer';
import { CodeViewer } from './CodeViewer';

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
  onOpenLightbox: (src: string, filename: string, fileSize?: number, onDownload?: () => void) => void;
  onAcceptApproval: (id: string, file: NonNullable<TransferItem['file']>) => void;
  onAlwaysTrustApproval: (id: string, file: NonNullable<TransferItem['file']>) => void;
  onRejectApproval: (id: string) => void;
  onPauseUpload: (id: string) => void;
  onResumeUpload: (id: string) => void;
  onCancelUpload: (id: string, transferId: string) => void;
  onToast: (text: string, type?: 'info' | 'success' | 'warning') => void;
}

function getFileIcon(filename: string, mediaKind?: MediaKind) {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  if (mediaKind === 'image' || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) {
    return <ImageIcon size={20} />;
  }
  if (mediaKind === 'video' || ['mp4', 'mkv', 'mov', 'webm', 'avi'].includes(ext)) {
    return <VideoIcon size={20} />;
  }
  if (mediaKind === 'audio' || ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a'].includes(ext)) {
    return <Music size={20} />;
  }
  if (mediaKind === 'code' || ['js', 'ts', 'tsx', 'jsx', 'py', 'go', 'rs', 'html', 'css', 'json'].includes(ext)) {
    return <FileCode size={20} />;
  }
  if (['zip', 'tar', 'gz', 'rar', '7z'].includes(ext)) {
    return <FileArchive size={20} />;
  }
  if (['xls', 'xlsx', 'csv'].includes(ext)) {
    return <FileSpreadsheet size={20} />;
  }
  if (['pdf', 'doc', 'docx', 'txt', 'md'].includes(ext) || mediaKind === 'pdf') {
    return <FileText size={20} />;
  }
  return <FileIcon size={20} />;
}

function formatCardTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export const TransferCard: React.FC<TransferCardProps> = ({
  item,
  isDeleting,
  onCopy,
  onDownload,
  onDelete,
  onOpenLightbox,
  onAcceptApproval,
  onAlwaysTrustApproval,
  onRejectApproval,
  onPauseUpload,
  onResumeUpload,
  onCancelUpload,
  onToast
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const isSent = item.sender === 'me';
  const isImageFile = item.file && (
    item.file.mediaKind === 'image' ||
    /\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i.test(item.file.filename)
  );

  const isTextLong = !!item.text && item.text.length > 220;
  const displayText = isTextLong && !isExpanded && item.text
    ? `${item.text.slice(0, 220)}...`
    : (item.text || '');

  return (
    <article className={`transfer-card ${isDeleting ? 'deleting' : ''}`}>
      {/* Activity Card Header */}
      <div className="card-top-row">
        <div className="card-direction-group">
          <span className={`direction-pill ${isSent ? 'sent' : 'received'}`}>
            {isSent ? <ArrowUpRight size={13} /> : <ArrowDownLeft size={13} />}
            <span>{isSent ? 'Sent' : 'Received'}</span>
          </span>

          <span className="card-timestamp">
            {formatCardTime(item.timestamp)}
          </span>

          {item.isPending && (
            <span className="card-pending-badge">
              <Clock size={11} />
              <span>Queued</span>
            </span>
          )}
        </div>

        <div className="card-actions-group">
          {item.text && (
            <button
              type="button"
              className="card-icon-action"
              onClick={() => onCopy(item.text!)}
              title="Copy text"
              aria-label="Copy text"
            >
              <Copy size={14} />
              <span>Copy</span>
            </button>
          )}

          {item.file && (
            <button
              type="button"
              className="card-icon-action card-action-accent"
              onClick={() => onDownload(item.id, item.file!, true)}
              disabled={item.file.isDownloading}
              title="Save to Downloads"
              aria-label="Save file to Downloads"
            >
              <Download size={14} />
              <span>{item.file.isDownloading ? `${Math.round(item.file.progress || 0)}%` : 'Save'}</span>
            </button>
          )}

          <button
            type="button"
            className="card-icon-action card-action-delete"
            onClick={() => onDelete(item.id)}
            title="Delete transfer record"
            aria-label="Delete"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {/* Text / Link Transfer Payload */}
      {item.text && (
        <div className="card-text-content">
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
      )}

      {/* Approval Required Container */}
      {item.file && item.file.isPendingApproval && (
        <div className="approval-card">
          <div className="approval-info">
            <span className="approval-filename">{item.file.filename}</span>
            <span className="approval-size">{formatBytes(item.file.totalSize)} • Transfer confirmation required</span>
          </div>
          <div className="approval-actions">
            <button
              type="button"
              className="approval-btn approval-reject"
              onClick={() => onRejectApproval(item.id)}
            >
              Reject
            </button>
            <button
              type="button"
              className="approval-btn approval-accept"
              onClick={() => onAcceptApproval(item.id, item.file!)}
            >
              Accept
            </button>
            <button
              type="button"
              className="approval-btn approval-trust"
              onClick={() => onAlwaysTrustApproval(item.id, item.file!)}
            >
              Always Trust PC
            </button>
          </div>
        </div>
      )}

      {/* File / Media Payload */}
      {item.file && !item.file.isPendingApproval && (
        <div className="card-file-content">
          {/* 1. Image Thumbnail & Metadata */}
          {isImageFile && (item.file.blobUrl || item.file.thumbnailUrl) ? (
            <div className="image-card-layout">
              <div
                className="image-thumbnail-box"
                onClick={() => {
                  const src = item.file!.blobUrl || item.file!.thumbnailUrl!;
                  onOpenLightbox(
                    src,
                    item.file!.filename,
                    item.file!.totalSize,
                    () => onDownload(item.id, item.file!, true)
                  );
                }}
              >
                <img
                  src={item.file.blobUrl || item.file.thumbnailUrl}
                  alt={item.file.filename}
                  loading="lazy"
                />
                <div className="thumbnail-zoom-hint">
                  <ZoomIn size={14} />
                  <span>Preview</span>
                </div>
              </div>

              <div className="image-metadata-box">
                <span className="image-filename" title={item.file.filename}>
                  {item.file.filename}
                </span>
                <span className="image-filesize">
                  {formatBytes(item.file.totalSize)}
                </span>
              </div>
            </div>
          ) : item.file.blobUrl && item.file.mediaKind === 'audio' ? (
            <AudioPlayer
              src={item.file.blobUrl}
              filename={item.file.filename}
              fileSize={item.file.totalSize}
              onDownload={() => onDownload(item.id, item.file!, true)}
            />
          ) : item.file.blobUrl && item.file.mediaKind === 'video' ? (
            <VideoPlayer
              src={item.file.blobUrl}
              filename={item.file.filename}
              fileSize={item.file.totalSize}
              onDownload={() => onDownload(item.id, item.file!, true)}
            />
          ) : item.file.blobUrl && item.file.mediaKind === 'pdf' ? (
            <PdfViewer
              src={item.file.blobUrl}
              filename={item.file.filename}
              fileSize={item.file.totalSize}
              onDownload={() => onDownload(item.id, item.file!, true)}
            />
          ) : item.file.snippet ? (
            <CodeViewer
              filename={item.file.filename}
              snippet={item.file.snippet}
              fullContent={item.file.fullContent}
              totalLines={item.file.totalLines}
              fileSize={item.file.totalSize}
              onDownload={() => onDownload(item.id, item.file!, true)}
              onCopyNotice={onToast}
            />
          ) : (
            /* Standard Document / Archive / Binary File Row */
            <div className="standard-file-row">
              <div className="file-icon-box">
                {getFileIcon(item.file.filename, item.file.mediaKind)}
              </div>
              <div className="file-info-box">
                <span className="file-name" title={item.file.filename}>
                  {item.file.filename}
                </span>
                <span className="file-size">
                  {formatBytes(item.file.totalSize)}
                </span>
              </div>
              {(item.file.mediaKind === 'image' ||
                item.file.mediaKind === 'audio' ||
                item.file.mediaKind === 'video' ||
                item.file.mediaKind === 'code' ||
                item.file.mediaKind === 'pdf') &&
                !item.file.blobUrl && (
                  <button
                    type="button"
                    className="file-preview-btn"
                    onClick={() => onDownload(item.id, item.file!, false)}
                    disabled={item.file.isDownloading}
                  >
                    Preview
                  </button>
                )}
            </div>
          )}

          {/* Active Upload Progress (Sender) */}
          {isSent && item.file.status && item.file.status !== 'done' && (
            <div className="progress-container">
              {item.file.status !== 'canceled' && (
                <div className="progress-bar-track">
                  <div
                    className="progress-bar-indicator"
                    style={{ width: `${Math.min(100, item.file.progress || 0)}%` }}
                  />
                </div>
              )}
              <div className="progress-meta-row">
                <span className="progress-status-label">
                  {item.file.status === 'uploading'
                    ? `Uploading ${Math.round(item.file.progress || 0)}%`
                    : item.file.status === 'queued'
                    ? 'Queued in transfer queue'
                    : item.file.status === 'paused'
                    ? 'Transfer paused'
                    : item.file.status === 'error'
                    ? 'Transfer interrupted'
                    : 'Canceled'}
                  {item.file.speed ? ` • ${formatSpeed(item.file.speed)}` : ''}
                </span>

                {item.file.status !== 'canceled' && (
                  <div className="progress-controls">
                    {(item.file.status === 'uploading' || item.file.status === 'queued') && (
                      <button
                        type="button"
                        onClick={() => onPauseUpload(item.id)}
                        className="progress-ctrl-btn"
                        title="Pause"
                      >
                        <Pause size={13} />
                      </button>
                    )}
                    {(item.file.status === 'paused' || item.file.status === 'error') && (
                      <button
                        type="button"
                        onClick={() => onResumeUpload(item.id)}
                        className="progress-ctrl-btn"
                        title="Resume"
                      >
                        <Play size={13} />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onCancelUpload(item.id, item.file!.transferId)}
                      className="progress-ctrl-btn progress-cancel"
                      title="Cancel"
                    >
                      <X size={13} />
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Active Download Progress (Receiver) */}
          {!isSent && item.file.isDownloading && (
            <div className="progress-container">
              <div className="progress-bar-track">
                <div
                  className="progress-bar-indicator"
                  style={{ width: `${Math.min(100, item.file.progress || 0)}%` }}
                />
              </div>
              <div className="progress-meta-row">
                <span className="progress-status-label">
                  Receiving {Math.round(item.file.progress || 0)}%
                  {item.file.speed ? ` • ${formatSpeed(item.file.speed)}` : ''}
                </span>
                <span className="progress-eta">{item.file.eta || ''}</span>
              </div>
            </div>
          )}

          {/* Error notice */}
          {item.file.error && !item.file.isDownloading && (
            <div className="transfer-error-notice">
              {item.file.error}
            </div>
          )}
        </div>
      )}
    </article>
  );
};
