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
    const onLoadedMetadata = () => setDuration(audio.duration || 0);

    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('loadedmetadata', onLoadedMetadata);

    return () => {
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
    };
  }, []);

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
    if (!sec || isNaN(sec)) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const percent = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="audio-player-card">
      <audio ref={audioRef} src={src} preload="metadata" />

      <div className="audio-player-top">
        <div className="audio-player-icon">
          <Music size={18} />
        </div>
        <div className="audio-player-meta">
          <div className="audio-player-name" title={filename}>{filename}</div>
          <div className="audio-player-details">
            {fileSize !== undefined && <span>{formatBytes(fileSize)}</span>}
            {duration > 0 && <span>• {formatSeconds(duration)}</span>}
          </div>
        </div>
        {onDownload && (
          <button className="icon-btn" onClick={onDownload} title="Download Audio">
            <Download size={16} />
          </button>
        )}
      </div>

      <div className="audio-player-controls">
        <button
          className="audio-play-btn"
          onClick={togglePlay}
          title={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? <Pause size={18} /> : <Play size={18} style={{ marginLeft: '2px' }} />}
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
              background: `linear-gradient(to right, var(--accent-color) ${percent}%, rgba(255,255,255,0.15) ${percent}%)`
            }}
          />
          <div className="audio-time-row">
            <span>{formatSeconds(currentTime)}</span>
            <span>{formatSeconds(duration)}</span>
          </div>
        </div>

        <button className="icon-btn" onClick={toggleMute} title={isMuted ? 'Unmute' : 'Mute'}>
          {isMuted ? <VolumeX size={16} /> : <Volume2 size={16} />}
        </button>
      </div>

      {isPlaying && (
        <div className="audio-waveform-bars" aria-hidden="true">
          <span style={{ animationDelay: '0.1s' }} />
          <span style={{ animationDelay: '0.3s' }} />
          <span style={{ animationDelay: '0.2s' }} />
          <span style={{ animationDelay: '0.4s' }} />
          <span style={{ animationDelay: '0.15s' }} />
        </div>
      )}
    </div>
  );
};
