import React, { useState, useEffect, useRef } from 'react';
import {
  ArrowLeft, Download, Share2, ZoomIn, ZoomOut,
  RotateCcw, RotateCw, Play, Pause, Volume2, VolumeX,
  AlertCircle
} from 'lucide-react';
import { backButtonManager } from '../lib/backButton';
import { formatBytes } from '../lib/telemetry';

export interface MediaViewerProps {
  type: 'image' | 'video';
  src: string;
  filename: string;
  fileSize?: number;
  onClose: () => void;
  onDownload?: () => void;
}

export const MediaViewer: React.FC<MediaViewerProps> = ({
  type,
  src,
  filename,
  fileSize,
  onClose,
  onDownload
}) => {
  // Chrome visibility (toggle on tap)
  const [isChromeVisible, setIsChromeVisible] = useState(true);

  // --- Image Zoom & Pan State ---
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0, posX: 0, posY: 0 });
  const initialPinchDistRef = useRef<number | null>(null);
  const initialScaleRef = useRef(1);
  const lastTapRef = useRef<number>(0);

  // --- Video Playback State ---
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoLoading, setIsVideoLoading] = useState(type === 'video');
  const [videoError, setVideoError] = useState('');
  const [bufferedPercent, setBufferedPercent] = useState(0);

  // Hardware Back Button & Escape integration
  useEffect(() => {
    const unregister = backButtonManager.push(() => {
      onClose();
      return true;
    });
    return unregister;
  }, [onClose]);

  // Keyboard controls
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (type === 'image') {
        if (e.key === '+' || e.key === '=') {
          setScale(s => Math.min(s + 0.35, 5));
        } else if (e.key === '-' || e.key === '_') {
          setScale(s => {
            const next = Math.max(s - 0.35, 0.5);
            if (next <= 1) setPosition({ x: 0, y: 0 });
            return next;
          });
        } else if (e.key === '0') {
          setScale(1);
          setPosition({ x: 0, y: 0 });
        }
      } else if (type === 'video' && videoRef.current) {
        if (e.key === ' ') {
          e.preventDefault();
          togglePlay();
        } else if (e.key === 'ArrowRight') {
          videoRef.current.currentTime = Math.min(videoRef.current.currentTime + 10, duration);
        } else if (e.key === 'ArrowLeft') {
          videoRef.current.currentTime = Math.max(videoRef.current.currentTime - 10, 0);
        } else if (e.key === 'm' || e.key === 'M') {
          setIsMuted(m => !m);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [type, duration, onClose]);

  // Video Lifecycle
  useEffect(() => {
    if (type !== 'video' || !videoRef.current) return;
    const v = videoRef.current;

    const onLoadedMetadata = () => {
      setDuration(v.duration || 0);
      setIsVideoLoading(false);
    };

    const onTimeUpdate = () => {
      setCurrentTime(v.currentTime);
      if (v.buffered.length > 0 && v.duration) {
        const bufferedEnd = v.buffered.end(v.buffered.length - 1);
        setBufferedPercent((bufferedEnd / v.duration) * 100);
      }
    };

    const onWaiting = () => setIsVideoLoading(true);
    const onPlaying = () => {
      setIsVideoLoading(false);
      setIsPlaying(true);
    };
    const onPause = () => setIsPlaying(false);
    const onEnded = () => {
      setIsPlaying(false);
      v.currentTime = 0;
    };
    const onError = () => {
      setIsVideoLoading(false);
      setVideoError('Unable to play video. The codec may not be supported by this device.');
    };

    v.addEventListener('loadedmetadata', onLoadedMetadata);
    v.addEventListener('timeupdate', onTimeUpdate);
    v.addEventListener('waiting', onWaiting);
    v.addEventListener('playing', onPlaying);
    v.addEventListener('pause', onPause);
    v.addEventListener('ended', onEnded);
    v.addEventListener('error', onError);

    return () => {
      v.pause();
      v.removeEventListener('loadedmetadata', onLoadedMetadata);
      v.removeEventListener('timeupdate', onTimeUpdate);
      v.removeEventListener('waiting', onWaiting);
      v.removeEventListener('playing', onPlaying);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('ended', onEnded);
      v.removeEventListener('error', onError);
    };
  }, [type, src]);

  // --- Image Interactions ---
  const handleZoomIn = () => setScale(s => Math.min(s + 0.5, 5));
  const handleZoomOut = () => {
    setScale(s => {
      const next = Math.max(s - 0.5, 0.5);
      if (next <= 1) setPosition({ x: 0, y: 0 });
      return next;
    });
  };
  const handleResetZoom = () => {
    setScale(1);
    setPosition({ x: 0, y: 0 });
  };

  const handleDoubleTap = (e: React.MouseEvent | React.TouchEvent) => {
    e.stopPropagation();
    if (scale !== 1) {
      handleResetZoom();
    } else {
      setScale(2.5);
    }
  };

  // Touch handling (pinch-to-zoom + 1-finger pan + double tap)
  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      // Pinch to zoom start
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      initialPinchDistRef.current = dist;
      initialScaleRef.current = scale;
      setIsDragging(false);
    } else if (e.touches.length === 1) {
      // Double tap detection
      const now = Date.now();
      if (now - lastTapRef.current < 280) {
        handleDoubleTap(e);
        lastTapRef.current = 0;
        return;
      }
      lastTapRef.current = now;

      // 1-finger pan start if zoomed
      if (scale > 1) {
        setIsDragging(true);
        dragStartRef.current = {
          x: e.touches[0].clientX,
          y: e.touches[0].clientY,
          posX: position.x,
          posY: position.y
        };
      }
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2 && initialPinchDistRef.current !== null) {
      // Pinching
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      const ratio = dist / initialPinchDistRef.current;
      const next = Math.min(Math.max(initialScaleRef.current * ratio, 0.5), 5);
      setScale(next);
      if (next <= 1) setPosition({ x: 0, y: 0 });
    } else if (e.touches.length === 1 && isDragging && scale > 1) {
      // Panning
      const dx = e.touches[0].clientX - dragStartRef.current.x;
      const dy = e.touches[0].clientY - dragStartRef.current.y;
      setPosition({
        x: dragStartRef.current.posX + dx,
        y: dragStartRef.current.posY + dy
      });
    }
  };

  const handleTouchEnd = () => {
    initialPinchDistRef.current = null;
    setIsDragging(false);
  };

  // Mouse drag handling (desktop/browser testing)
  const handleMouseDown = (e: React.MouseEvent) => {
    if (scale <= 1) return;
    setIsDragging(true);
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      posX: position.x,
      posY: position.y
    };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging || scale <= 1) return;
    const dx = e.clientX - dragStartRef.current.x;
    const dy = e.clientY - dragStartRef.current.y;
    setPosition({
      x: dragStartRef.current.posX + dx,
      y: dragStartRef.current.posY + dy
    });
  };

  const handleMouseUp = () => setIsDragging(false);

  // Video controls
  const togglePlay = () => {
    if (!videoRef.current) return;
    if (isPlaying) {
      videoRef.current.pause();
    } else {
      videoRef.current.play().catch(() => {});
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!videoRef.current) return;
    const time = parseFloat(e.target.value);
    videoRef.current.currentTime = time;
    setCurrentTime(time);
  };

  const skipTime = (seconds: number) => {
    if (!videoRef.current) return;
    videoRef.current.currentTime = Math.min(Math.max(videoRef.current.currentTime + seconds, 0), duration);
  };

  const formatTime = (secs: number) => {
    if (isNaN(secs) || secs < 0) return '0:00';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const handleShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: filename,
          url: src
        });
      } catch {}
    }
  };

  return (
    <div
      className="media-viewer-root"
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      {/* Top App Bar */}
      <header className={`media-viewer-header ${!isChromeVisible ? 'chrome-hidden' : ''}`}>
        <div className="viewer-header-left">
          <button
            type="button"
            className="viewer-icon-btn viewer-back-btn"
            onClick={onClose}
            title="Close viewer (Back)"
            aria-label="Back"
          >
            <ArrowLeft size={22} />
          </button>
          <div className="viewer-header-title-box">
            <span className="viewer-filename" title={filename}>{filename}</span>
            <span className="viewer-meta">
              {fileSize !== undefined && fileSize > 0 ? `${formatBytes(fileSize)} • ` : ''}
              {type === 'image' ? `${Math.round(scale * 100)}%` : formatTime(duration)}
            </span>
          </div>
        </div>

        <div className="viewer-header-actions">
          {typeof navigator.share === 'function' && (
            <button
              type="button"
              className="viewer-icon-btn"
              onClick={handleShare}
              title="Share"
              aria-label="Share"
            >
              <Share2 size={19} />
            </button>
          )}

          {onDownload && (
            <button
              type="button"
              className="viewer-btn-save"
              onClick={onDownload}
              title="Save to Downloads"
            >
              <Download size={16} />
              <span>Save</span>
            </button>
          )}
        </div>
      </header>

      {/* Main Media Stage */}
      <main
        className="media-viewer-stage"
        onClick={() => setIsChromeVisible(v => !v)}
      >
        {type === 'image' ? (
          <div
            className="media-image-canvas"
            onMouseDown={handleMouseDown}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onDoubleClick={handleDoubleTap}
            style={{
              cursor: scale > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default'
            }}
          >
            <img
              src={src}
              alt={filename}
              className="media-image-element"
              style={{
                transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
                transition: isDragging || initialPinchDistRef.current ? 'none' : 'transform 0.15s cubic-bezier(0, 0, 0.2, 1)'
              }}
              draggable={false}
            />
          </div>
        ) : (
          <div className="media-video-container" onClick={e => e.stopPropagation()}>
            {videoError ? (
              <div className="media-video-error">
                <AlertCircle size={32} />
                <p className="error-text">{videoError}</p>
                {onDownload && (
                  <button type="button" className="btn btn-secondary" onClick={onDownload}>
                    Save and open with system player
                  </button>
                )}
              </div>
            ) : (
              <>
                <video
                  ref={videoRef}
                  src={src}
                  playsInline
                  preload="metadata"
                  muted={isMuted}
                  className="media-video-element"
                  onClick={togglePlay}
                />

                {/* Big Center Play Indicator when Paused */}
                {!isPlaying && !isVideoLoading && (
                  <button
                    type="button"
                    className="video-center-play-badge"
                    onClick={togglePlay}
                    aria-label="Play video"
                  >
                    <Play size={36} fill="currentColor" />
                  </button>
                )}

                {isVideoLoading && (
                  <div className="video-loading-spinner" />
                )}
              </>
            )}
          </div>
        )}
      </main>

      {/* Bottom Controls Chrome */}
      {type === 'image' && (
        <div className={`media-viewer-dock ${!isChromeVisible ? 'chrome-hidden' : ''}`}>
          <button
            type="button"
            className="dock-icon-btn"
            onClick={handleZoomOut}
            title="Zoom Out"
            aria-label="Zoom Out"
          >
            <ZoomOut size={18} />
          </button>
          <button
            type="button"
            className="dock-scale-badge"
            onClick={handleResetZoom}
            title="Reset to 100%"
          >
            {Math.round(scale * 100)}%
          </button>
          <button
            type="button"
            className="dock-icon-btn"
            onClick={handleZoomIn}
            title="Zoom In"
            aria-label="Zoom In"
          >
            <ZoomIn size={18} />
          </button>
          <div className="dock-divider" />
          <button
            type="button"
            className="dock-icon-btn"
            onClick={handleResetZoom}
            title="Reset position and zoom"
            aria-label="Reset zoom and position"
          >
            <RotateCcw size={16} />
          </button>
        </div>
      )}

      {type === 'video' && !videoError && (
        <div className={`media-video-controls ${!isChromeVisible ? 'chrome-hidden' : ''}`}>
          {/* Progress Timeline Slider */}
          <div className="video-timeline-wrapper">
            <div
              className="video-timeline-buffer"
              style={{ width: `${bufferedPercent}%` }}
            />
            <input
              type="range"
              min={0}
              max={duration || 100}
              step={0.1}
              value={currentTime}
              onChange={handleSeek}
              className="video-timeline-slider"
              aria-label="Video timeline seek"
            />
          </div>

          <div className="video-bottom-row">
            <div className="video-ctrl-group">
              <button
                type="button"
                className="video-ctrl-btn"
                onClick={togglePlay}
                title={isPlaying ? 'Pause' : 'Play'}
                aria-label={isPlaying ? 'Pause' : 'Play'}
              >
                {isPlaying ? <Pause size={20} /> : <Play size={20} fill="currentColor" />}
              </button>

              <button
                type="button"
                className="video-ctrl-btn"
                onClick={() => skipTime(-10)}
                title="Rewind 10 seconds"
                aria-label="Rewind 10 seconds"
              >
                <RotateCcw size={18} />
              </button>

              <button
                type="button"
                className="video-ctrl-btn"
                onClick={() => skipTime(10)}
                title="Forward 10 seconds"
                aria-label="Forward 10 seconds"
              >
                <RotateCw size={18} />
              </button>

              <span className="video-time-readout">
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>
            </div>

            <div className="video-ctrl-group">
              <button
                type="button"
                className="video-ctrl-btn"
                onClick={() => setIsMuted(m => !m)}
                title={isMuted ? 'Unmute' : 'Mute'}
                aria-label={isMuted ? 'Unmute' : 'Mute'}
              >
                {isMuted ? <VolumeX size={19} /> : <Volume2 size={19} />}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

