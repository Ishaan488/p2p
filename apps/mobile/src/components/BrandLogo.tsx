import React from 'react';

interface BrandLogoProps {
  size?: number;
  connected?: boolean;
  className?: string;
}

/**
 * P2P Link Bespoke Geometric Brand Mark
 * Two interlocking rounded-square nodes linked by an encrypted core pulse.
 */
export const BrandLogo: React.FC<BrandLogoProps> = ({
  size = 22,
  connected = false,
  className = ''
}) => {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      {/* Top-Left Node */}
      <rect
        x="4.5"
        y="4.5"
        width="13.5"
        height="13.5"
        rx="3.8"
        stroke="currentColor"
        strokeWidth="2.2"
      />
      {/* Bottom-Right Interlocking Node */}
      <rect
        x="14"
        y="14"
        width="13.5"
        height="13.5"
        rx="3.8"
        stroke="currentColor"
        strokeWidth="2.2"
      />
      {/* Core Link Nodes */}
      <circle
        cx="11.25"
        cy="11.25"
        r="1.75"
        fill={connected ? 'var(--accent)' : 'currentColor'}
      />
      <circle
        cx="20.75"
        cy="20.75"
        r="1.75"
        fill={connected ? 'var(--accent)' : 'currentColor'}
      />
      <path
        d="M11.25 11.25L20.75 20.75"
        stroke={connected ? 'var(--accent)' : 'currentColor'}
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
};

