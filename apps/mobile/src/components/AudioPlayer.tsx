import React, { useState, useRef, useEffect } from 'react';
import { Play, Pause, Volume2, VolumeX, Download, Music } from 'lucide-react';
import { formatBytes } from '../lib/telemetry';

interface AudioPlayerProps {
  src: string;
  filename: string;
  fileSize?: number;
  onDownload?: () => void;
}

export const AudioPlayer: React.FC<AudioPlayerProps> = ({
  src,
  filename,
  fileSize,
  onDownload
}) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isMuted, setIsMuted] = useState(false);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onEnded = () => {
      setIsPlaying(false);
      setCurrentTime(0);
    };
    const onTimeUpdate = () => setCurrentTime(audio.currentTime);
    const onLoadedMetadata = () => {
      if (audio.duration && isFinite(audio.duration)) {
        setDuration(audio.duration);
      }
    };

    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('loadedmetadata', onLoadedMetadata);

    return () => {
      audio.pause();
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
    };
  }, [src]);

  const togglePlay = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
    } else {
      audioRef.current.play().catch(console.error);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const targetTime = parseFloat(e.target.value);
    setCurrentTime(targetTime);
    if (audioRef.current) {
      audioRef.current.currentTime = targetTime;
    }
  };

  const toggleMute = () => {
    if (!audioRef.current) return;
    audioRef.current.muted = !isMuted;
    setIsMuted(!isMuted);
  };

  const formatSeconds = (sec: number) => {
    if (!sec || isNaN(sec) || !isFinite(sec)) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const percent = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const ext = filename.split('.').pop()?.toUpperCase() || 'AUDIO';

  return (
    <div className="audio-player-card">
      <audio ref={audioRef} src={src} preload="metadata" />

      <div className="audio-player-top">
        <div className={`audio-player-icon ${isPlaying ? 'playing' : ''}`}>
          {isPlaying ? (
            <div className="audio-waveform-bars" aria-hidden="true">
              <span style={{ animationDelay: '0.05s' }} />
              <span style={{ animationDelay: '0.25s' }} />
              <span style={{ animationDelay: '0.15s' }} />
              <span style={{ animationDelay: '0.35s' }} />
            </div>
          ) : (
            <Music size={18} />
          )}
        </div>

        <div className="audio-player-meta">
          <div className="audio-player-name" title={filename}>{filename}</div>
          <div className="audio-player-details">
            <span className="file-ext-pill">{ext}</span>
            {fileSize !== undefined && <span>{formatBytes(fileSize)}</span>}
            {duration > 0 && <span>• {formatSeconds(duration)}</span>}
          </div>
        </div>

        {onDownload && (
          <button
            type="button"
            className="icon-btn"
            onClick={onDownload}
            title="Save Audio"
            aria-label="Save Audio"
          >
            <Download size={15} />
          </button>
        )}
      </div>

      <div className="audio-player-controls">
        <button
          type="button"
          className="audio-play-btn"
          onClick={togglePlay}
          title={isPlaying ? 'Pause' : 'Play'}
          aria-label={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? <Pause size={16} /> : <Play size={16} style={{ marginLeft: '2px' }} />}
        </button>

        <div className="audio-scrubber-container">
          <input
            type="range"
            min={0}
            max={duration || 100}
            step={0.1}
            value={currentTime}
            onChange={handleSeek}
            className="audio-scrubber"
            style={{
              background: `linear-gradient(to right, var(--accent) ${percent}%, var(--border-strong) ${percent}%)`
            }}
          />
          <div className="audio-time-row">
            <span>{formatSeconds(currentTime)}</span>
            <span>{formatSeconds(duration)}</span>
          </div>
        </div>

        <button
          type="button"
          className="icon-btn"
          onClick={toggleMute}
          title={isMuted ? 'Unmute' : 'Mute'}
          aria-label={isMuted ? 'Unmute' : 'Mute'}
        >
          {isMuted ? <VolumeX size={16} /> : <Volume2 size={16} />}
        </button>
      </div>
    </div>
  );
};
