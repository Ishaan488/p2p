import React, { useMemo } from 'react';
import {
  Plus,
  FileText,
  Image,
  Film,
  Music,
  FolderUp,
  ClipboardPaste,
  Lock
} from 'lucide-react';

export type FileCategoryFilter = 'all' | 'image' | 'video' | 'audio' | 'docs' | 'folder';

export interface TransferActionPanelProps {
  onOpenFilePicker: (accept?: string, isFolder?: boolean) => void;
  onOpenSendText: () => void;
  onQuickSendClipboard?: () => void;
  targetDeviceName?: string;
}

export const TransferActionPanel: React.FC<TransferActionPanelProps> = ({
  onOpenFilePicker,
  onOpenSendText,
  onQuickSendClipboard,
  targetDeviceName
}) => {
  // Resolve active recipient desktop or peer name with graceful fallback to saved pairing
  const resolvedTarget = useMemo(() => {
    if (targetDeviceName?.trim()) {
      return targetDeviceName.trim();
    }
    try {
      const pairing = JSON.parse(localStorage.getItem('p2p_pairing') || 'null');
      if (pairing?.serverName?.trim()) {
        return pairing.serverName.trim();
      }
    } catch {
      // Ignore parse errors and fallback
    }
    return 'Desktop PC';
  }, [targetDeviceName]);

  // Direct categories surfaced immediately without requiring hidden filter menus
  const categories = useMemo(() => [
    {
      id: 'photos',
      label: 'Photos',
      icon: Image,
      title: 'Send photos, images & graphics',
      onClick: () => onOpenFilePicker('image/*', false)
    },
    {
      id: 'videos',
      label: 'Videos',
      icon: Film,
      title: 'Send video recordings & media clips',
      onClick: () => onOpenFilePicker('video/*', false)
    },
    {
      id: 'audio',
      label: 'Audio',
      icon: Music,
      title: 'Send songs, voice memos & audio tracks',
      onClick: () => onOpenFilePicker('audio/*', false)
    },
    {
      id: 'docs',
      label: 'Docs',
      icon: FileText,
      title: 'Send documents, PDFs, sheets & archives',
      onClick: () =>
        onOpenFilePicker(
          '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.csv,.json,.zip,.rar,.7z',
          false
        )
    },
    {
      id: 'folder',
      label: 'Folder',
      icon: FolderUp,
      title: 'Send an entire folder or directory structure',
      onClick: () => onOpenFilePicker(undefined, true)
    },
    {
      id: 'paste',
      label: 'Paste & Send',
      icon: ClipboardPaste,
      title: 'Send copied text, URLs, or clipboard content',
      onClick: () => {
        if (onQuickSendClipboard) {
          onQuickSendClipboard();
        } else {
          onOpenSendText();
        }
      }
    }
  ], [onOpenFilePicker, onOpenSendText, onQuickSendClipboard]);

  return (
    <footer
      className="transfer-action-panel tap-root"
      role="region"
      aria-label="Send files and transfer options"
    >
      <style>{`
        .tap-root {
          position: fixed;
          bottom: 0;
          left: 0;
          right: 0;
          max-width: 760px;
          margin: 0 auto;
          background: var(--surface-glass, rgba(32, 30, 39, 0.92));
          backdrop-filter: blur(24px);
          -webkit-backdrop-filter: blur(24px);
          border-top: 1px solid var(--border-subtle, #383442);
          padding: 0.55rem 0.9rem;
          padding-bottom: calc(0.65rem + env(safe-area-inset-bottom, 0px));
          z-index: 25;
          box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.35);
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
          user-select: none;
          box-sizing: border-box;
        }

        /* 1. Destination Target Feedback Banner */
        .tap-target-banner {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0.2rem 0.4rem;
          font-size: 0.72rem;
          color: var(--text-secondary, #B1AABD);
          letter-spacing: -0.01em;
        }

        .tap-target-left {
          display: flex;
          align-items: center;
          gap: 0.42rem;
          min-width: 0;
          overflow: hidden;
        }

        .tap-pulse-dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: var(--accent, #A995D5);
          box-shadow: 0 0 8px var(--accent, #A995D5);
          flex-shrink: 0;
          animation: tapPulse 2.4s ease-in-out infinite;
        }

        @keyframes tapPulse {
          0%, 100% {
            opacity: 1;
            transform: scale(1);
          }
          50% {
            opacity: 0.55;
            transform: scale(0.85);
          }
        }

        .tap-target-text {
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .tap-target-name {
          color: var(--text-primary, #F0EDF5);
          font-weight: 600;
        }

        .tap-target-badge {
          display: inline-flex;
          align-items: center;
          gap: 0.25rem;
          padding: 0.16rem 0.45rem;
          border-radius: 9999px;
          background: var(--accent-subtle, rgba(169, 149, 213, 0.12));
          border: 1px solid var(--accent-border, rgba(169, 149, 213, 0.24));
          color: var(--accent, #A995D5);
          font-size: 0.68rem;
          font-weight: 600;
          flex-shrink: 0;
          letter-spacing: 0.02em;
        }

        /* 2. Direct Category Picker Strip */
        .tap-category-strip {
          display: flex;
          align-items: center;
          gap: 0.45rem;
          overflow-x: auto;
          overflow-y: hidden;
          -webkit-overflow-scrolling: touch;
          scrollbar-width: none;
          padding: 0.1rem 0.2rem 0.25rem 0.2rem;
          margin: 0 -0.2rem;
        }

        .tap-category-strip::-webkit-scrollbar {
          display: none;
        }

        .tap-category-chip {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 0.38rem;
          height: 42px;
          min-height: 42px;
          min-width: 44px;
          padding: 0 0.85rem;
          border-radius: 9999px;
          background: var(--surface-secondary, #292633);
          border: 1px solid var(--border-subtle, #383442);
          color: var(--text-primary, #F0EDF5);
          font-size: 0.78rem;
          font-weight: 600;
          white-space: nowrap;
          cursor: pointer;
          flex-shrink: 0;
          transition: transform 120ms ease, background 160ms ease, border-color 160ms ease, box-shadow 160ms ease;
          touch-action: manipulation;
          -webkit-tap-highlight-color: transparent;
        }

        .tap-category-chip:hover {
          background: var(--surface-hover, #383442);
          border-color: var(--accent-border, rgba(169, 149, 213, 0.35));
        }

        .tap-category-chip:active {
          transform: scale(0.96);
          background: var(--surface-hover, #383442);
        }

        .tap-chip-icon {
          color: var(--accent, #A995D5);
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }

        .tap-chip-label {
          line-height: 1;
        }

        /* 3. Primary & Secondary CTA Action Bar */
        .tap-actions-row {
          display: flex;
          align-items: center;
          gap: 0.6rem;
        }

        .tap-btn {
          flex: 1;
          height: 48px;
          min-height: 48px;
          border-radius: 9999px;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 0.5rem;
          font-size: 0.9rem;
          font-weight: 650;
          letter-spacing: -0.01em;
          cursor: pointer;
          transition: transform 120ms ease, background 160ms ease, box-shadow 160ms ease;
          border: 1px solid transparent;
          touch-action: manipulation;
          -webkit-tap-highlight-color: transparent;
        }

        .tap-btn:active {
          transform: scale(0.975);
        }

        .tap-btn-primary {
          flex: 1.25;
          background: var(--btn-primary-bg, #A995D5);
          color: var(--btn-primary-text, #17161D);
          box-shadow: 0 2px 12px rgba(169, 149, 213, 0.28);
        }

        .tap-btn-primary:hover {
          background: var(--btn-primary-hover, #B9A9DF);
          box-shadow: 0 4px 16px rgba(169, 149, 213, 0.38);
        }

        .tap-btn-secondary {
          flex: 1;
          background: var(--surface-secondary, #292633);
          border-color: var(--border-subtle, #383442);
          color: var(--text-primary, #F0EDF5);
        }

        .tap-btn-secondary:hover {
          background: var(--surface-hover, #383442);
          border-color: var(--accent-border, rgba(169, 149, 213, 0.24));
        }

        @media (max-width: 400px) {
          .tap-root {
            padding-left: 0.65rem;
            padding-right: 0.65rem;
          }
          .tap-category-chip {
            padding: 0 0.72rem;
            font-size: 0.74rem;
            height: 40px;
          }
          .tap-btn {
            height: 46px;
            font-size: 0.85rem;
          }
        }
      `}</style>

      {/* Destination Target Feedback */}
      <div className="tap-target-banner" aria-label={`Sending to ${resolvedTarget} (End-to-end encrypted)`}>
        <div className="tap-target-left">
          <span className="tap-pulse-dot" aria-hidden="true" />
          <span className="tap-target-text">
            Sending to <strong className="tap-target-name">{resolvedTarget}</strong>
          </span>
        </div>
        <div className="tap-target-badge" title="End-to-End Encrypted Direct Transfer">
          <Lock size={11} strokeWidth={2.4} aria-hidden="true" />
          <span>E2EE</span>
        </div>
      </div>

      {/* Modern, Frictionless Category Strip (Photos, Videos, Audio, Docs, Folder, Paste & Send) */}
      <div
        className="category-picker-strip tap-category-strip"
        role="toolbar"
        aria-label="Direct file type selections"
      >
        {categories.map((cat) => {
          const Icon = cat.icon;
          return (
            <button
              key={cat.id}
              type="button"
              className="category-chip tap-category-chip"
              onClick={cat.onClick}
              title={cat.title}
              aria-label={cat.label}
            >
              <span className="tap-chip-icon" aria-hidden="true">
                <Icon size={16} strokeWidth={2.2} />
              </span>
              <span className="tap-chip-label">{cat.label}</span>
            </button>
          );
        })}
      </div>

      {/* Primary Action Buttons (Send Files & Send Text) */}
      <div className="action-panel-inner tap-actions-row">
        <button
          type="button"
          className="action-btn action-btn-primary tap-btn tap-btn-primary"
          onClick={() => onOpenFilePicker('*/*', false)}
          title="Select files, photos, or media from device"
          aria-label="Send Files"
        >
          <Plus size={19} strokeWidth={2.6} />
          <span>Send Files</span>
        </button>

        <button
          type="button"
          className="action-btn action-btn-secondary tap-btn tap-btn-secondary"
          onClick={onOpenSendText}
          title="Send text note, link, or clipboard message"
          aria-label="Send Text"
        >
          <FileText size={17} strokeWidth={2.2} />
          <span>Send Text</span>
        </button>
      </div>
    </footer>
  );
};
