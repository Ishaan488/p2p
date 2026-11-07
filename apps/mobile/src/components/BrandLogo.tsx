import React, { useEffect, useState } from 'react';
import logoIdle from '../assets/logo-idle.png';
import logoConnected from '../assets/logo-connected.png';

export interface BrandLogoProps {
  size?: number;
  connected?: boolean;
  connecting?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * P2P Link Brand Logo Component
 * Renders the new P2P monogram mark:
 * - Idle / disconnected (3.png): Crisp white letters on dark squircle
 * - Connected / transferring (4.png): Electric blue gradient on the central '2'
 * 
 * Implements a dual-layer GPU-accelerated cross-fade:
 * When connection state activates, the electric cyan/sapphire blue gradient blooms
 * seamlessly into the '2' with a gentle radiant glow aura over 0.45s.
 */
export const BrandLogo: React.FC<BrandLogoProps> = ({
  size = 28,
  connected = false,
  connecting = false,
  className = '',
  style
}) => {
  const [activeConnected, setActiveConnected] = useState(false);

  useEffect(() => {
    if (connected) {
      // Trigger smooth bloom transition on next frame
      const frame = requestAnimationFrame(() => {
        setActiveConnected(true);
      });
      return () => cancelAnimationFrame(frame);
    } else {
      setActiveConnected(false);
    }
  }, [connected]);

  const borderRadius = Math.max(3, Math.round(size * 0.22));

  return (
    <span
      className={`brand-logo-container ${connected ? 'is-connected' : 'is-idle'} ${connecting ? 'is-connecting' : ''} ${className}`}
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        borderRadius: `${borderRadius}px`,
        flexShrink: 0,
        verticalAlign: 'middle',
        transform: 'translateZ(0)',
        filter: activeConnected
          ? 'drop-shadow(0 0 6px rgba(0, 185, 255, 0.42))'
          : 'drop-shadow(0 0 0px rgba(0, 0, 0, 0))',
        transition: 'filter 0.45s cubic-bezier(0.4, 0, 0.2, 1)',
        animation: connecting && !activeConnected ? 'brand-pulse 1.8s ease-in-out infinite' : undefined,
        ...style
      }}
      aria-label={connected ? 'P2P Link (Connected)' : 'P2P Link'}
    >
      {/* Base Layer: Crisp all-white P2P monogram on black squircle */}
      <img
        src={logoIdle}
        alt=""
        aria-hidden="true"
        width={size}
        height={size}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          borderRadius: `${borderRadius}px`,
          pointerEvents: 'none',
          userSelect: 'none'
        }}
      />

      {/* Overlay Layer: Electric Cyan/Sapphire Gradient blooming smoothly on the '2' */}
      <img
        src={logoConnected}
        alt=""
        aria-hidden="true"
        width={size}
        height={size}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          borderRadius: `${borderRadius}px`,
          pointerEvents: 'none',
          userSelect: 'none',
          opacity: activeConnected ? 1 : 0,
          transform: activeConnected ? 'scale(1)' : 'scale(0.96)',
          transition: 'opacity 0.45s cubic-bezier(0.4, 0, 0.2, 1), transform 0.45s cubic-bezier(0.16, 1, 0.3, 1)',
          willChange: 'opacity, transform'
        }}
      />
    </span>
  );
};

export default BrandLogo;
