import React from 'react';
import { Download, Film } from 'lucide-react';
import { formatBytes } from '../lib/telemetry';

interface VideoPlayerProps {
  src: string;
  filename: string;
  fileSize?: number;
  onDownload?: () => void;
}

export const VideoPlayer: React.FC<VideoPlayerProps> = ({
  src,
  filename,
  fileSize,
  onDownload
}) => {
  return (
    <div className="video-player-card">
      <div className="video-player-top">
        <div className="video-icon-badge">
          <Film size={16} />
        </div>
        <div className="video-title" title={filename}>{filename}</div>
        {fileSize !== undefined && (
          <span className="video-size">{formatBytes(fileSize)}</span>
        )}
        {onDownload && (
          <button className="icon-btn" onClick={onDownload} title="Download Video">
            <Download size={16} />
          </button>
        )}
      </div>

      <div className="video-element-wrapper">
        <video
          src={src}
          controls
          playsInline
          preload="metadata"
          className="video-element"
        >
          Your browser does not support HTML5 video preview.
        </video>
      </div>
    </div>
  );
};
