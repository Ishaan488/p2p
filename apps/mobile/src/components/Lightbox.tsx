import React, { useState, useEffect, useRef } from 'react';
import { ZoomIn, ZoomOut, RotateCcw, Download, X } from 'lucide-react';
import { backButtonManager } from '../lib/backButton';
import { formatBytes } from '../lib/telemetry';

interface LightboxProps {
  src: string;
  filename: string;
  fileSize?: number;
  onClose: () => void;
  onDownload?: () => void;
}

export const Lightbox: React.FC<LightboxProps> = ({
  src,
  filename,
  fileSize,
  onClose,
  onDownload
}) => {
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0, posX: 0, posY: 0 });

  // Hook into backButtonManager so hardware back button & Esc close the lightbox
  useEffect(() => {
    const unregister = backButtonManager.push(() => {
      onClose();
      return true;
    });
    return unregister;
  }, [onClose]);

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === '+' || e.key === '=') {
        setScale(s => Math.min(s + 0.25, 4));
      } else if (e.key === '-' || e.key === '_') {
        setScale(s => Math.max(s - 0.25, 0.5));
      } else if (e.key === '0') {
        setScale(1);
        setPosition({ x: 0, y: 0 });
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleZoomIn = () => setScale(s => Math.min(s + 0.25, 4));
  const handleZoomOut = () => {
    setScale(s => {
      const next = Math.max(s - 0.25, 0.5);
      if (next <= 1) setPosition({ x: 0, y: 0 });
      return next;
    });
  };
  const handleReset = () => {
    setScale(1);
    setPosition({ x: 0, y: 0 });
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.15 : -0.15;
    setScale(s => {
      const next = Math.min(Math.max(s + delta, 0.5), 4);
      if (next <= 1) setPosition({ x: 0, y: 0 });
      return next;
    });
  };

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
    if (!isDragging) return;
    const dx = e.clientX - dragStartRef.current.x;
    const dy = e.clientY - dragStartRef.current.y;
    setPosition({
      x: dragStartRef.current.posX + dx,
      y: dragStartRef.current.posY + dy
    });
  };

  const handleMouseUp = () => setIsDragging(false);

  const handleTouchStart = (e: React.TouchEvent) => {
    if (scale <= 1 || e.touches.length !== 1) return;
    setIsDragging(true);
    dragStartRef.current = {
      x: e.touches[0].clientX,
      y: e.touches[0].clientY,
      posX: position.x,
      posY: position.y
    };
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!isDragging || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - dragStartRef.current.x;
    const dy = e.touches[0].clientY - dragStartRef.current.y;
    setPosition({
      x: dragStartRef.current.posX + dx,
      y: dragStartRef.current.posY + dy
    });
  };

  const handleTouchEnd = () => setIsDragging(false);

  const handleDoubleClick = () => {
    if (scale !== 1) {
      handleReset();
    } else {
      setScale(2);
    }
  };

  return (
    <div
      className="lightbox-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onWheel={handleWheel}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      <div className="lightbox-header">
        <div className="lightbox-info">
          <span className="lightbox-title">{filename}</span>
          <span className="lightbox-subtitle">
            {fileSize !== undefined && fileSize > 0 ? `${formatBytes(fileSize)} • ` : ''}
            {Math.round(scale * 100)}%
          </span>
        </div>

        <div className="lightbox-actions">
          {onDownload && (
            <button className="lightbox-save-btn" onClick={onDownload} title="Save to Downloads">
              <Download size={16} />
              <span>Save</span>
            </button>
          )}
          <button className="icon-btn lightbox-close" onClick={onClose} title="Close (Esc)">
            <X size={20} />
          </button>
        </div>
      </div>

      <div
        className="lightbox-body"
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onDoubleClick={handleDoubleClick}
        style={{ cursor: scale > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default' }}
      >
        <img
          src={src}
          alt={filename}
          className="lightbox-image"
          style={{
            transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
            transition: isDragging ? 'none' : 'transform 0.15s ease-out'
          }}
          draggable={false}
        />
      </div>

      <div className="lightbox-dock">
        <button className="lightbox-dock-btn" onClick={handleZoomOut} title="Zoom Out (-)">
          <ZoomOut size={18} />
        </button>
        <button className="lightbox-dock-scale" onClick={handleReset} title="Reset Zoom">
          {Math.round(scale * 100)}%
        </button>
        <button className="lightbox-dock-btn" onClick={handleZoomIn} title="Zoom In (+)">
          <ZoomIn size={18} />
        </button>
        <div className="lightbox-dock-divider" />
        <button className="lightbox-dock-btn" onClick={handleReset} title="Reset Position">
          <RotateCcw size={16} />
        </button>
      </div>
    </div>
  );
};
