import React from 'react';
import { PikaIcon, type IconSvgElement } from '@pikaicons/react';
import {
  AlertCircleIcon,
  AlertTriangleIcon,
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  ChatIcon,
  CheckTickCircleIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  ClipboardCheckIcon,
  CodeIcon,
  CopyIcon,
  DeleteDustbin01Icon,
  DownloadBarDownIcon,
  EnvelopeIcon,
  ExternalLinkSquareIcon,
  EyeOffIcon,
  EyeOnIcon,
  File02Icon,
  FileIcon,
  FolderIcon,
  LaptopIcon,
  LinkSlantIcon,
  LogOutRightIcon,
  MinusIcon,
  MoonIcon,
  MultipleCrossCancelIcon,
  MusicBeamNoteIcon,
  Package01Icon,
  PauseCircleIcon,
  PencilEditIcon,
  PhoneIcon,
  PhotoImageIcon,
  PlayCircleIcon,
  PlusIcon,
  QrIcon,
  QuestionMarkCircleIcon,
  RefreshIcon,
  SendPlaneHorizontalIcon,
  Settings01Icon,
  Share01Icon,
  ShieldCheckIcon,
  ShieldIcon,
  SpeakerOnIcon,
  SunIcon,
  ThreeDotsMenuHorizontalIcon,
  ThreeDotsMenuVerticalIcon,
  TroubleshootIcon,
  TvIcon,
  UploadBarUpIcon,
  UploadUpIcon,
  UserCircleIcon,
  VideoCallIcon,
  VolumeTwoIcon,
  WifiOnIcon,
} from '@pikaicons/core-free';

export interface IconProps extends React.SVGProps<SVGSVGElement> {
  size?: number | string;
  color?: string;
  strokeWidth?: number | string;
  className?: string;
  style?: React.CSSProperties;
}

function createPikaComponent(
  iconData: IconSvgElement,
  displayName: string,
  defaultTransform?: string
) {
  const Comp = React.forwardRef<SVGSVGElement, IconProps>((props, ref) => {
    const {
      size = 20,
      color = 'currentColor',
      strokeWidth = 2,
      className,
      style,
      ...rest
    } = props;

    const mergedStyle = defaultTransform
      ? { transform: defaultTransform, ...style }
      : style;

    return (
      <PikaIcon
        ref={ref}
        icon={iconData}
        size={size}
        color={color}
        strokeWidth={strokeWidth}
        className={className}
        style={mergedStyle}
        {...rest}
      />
    );
  });
  Comp.displayName = displayName;
  return Comp;
}

// ---------------------------------------------------------------------------
// Hardware & Devices
// ---------------------------------------------------------------------------
export const Laptop = createPikaComponent(LaptopIcon, 'Laptop');
export const Smartphone = createPikaComponent(PhoneIcon, 'Smartphone');
export const Monitor = createPikaComponent(TvIcon, 'Monitor');
export const Wifi = createPikaComponent(WifiOnIcon, 'Wifi');

// WifiOff: Wifi icon with a diagonal strike overlay
export const WifiOff = React.forwardRef<SVGSVGElement, IconProps>((props, ref) => {
  const { size = 20, color = 'currentColor', strokeWidth = 2, className, style, ...rest } = props;
  return (
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size, height: size }}>
      <PikaIcon ref={ref} icon={WifiOnIcon} size={size} color={color} strokeWidth={strokeWidth} className={className} style={{ opacity: 0.5, ...style }} {...rest} />
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        <line x1="3" y1="3" x2="21" y2="21" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
      </svg>
    </span>
  );
});
WifiOff.displayName = 'WifiOff';

// ---------------------------------------------------------------------------
// Navigation & Arrows
// ---------------------------------------------------------------------------
export const ChevronDown = createPikaComponent(ChevronDownIcon, 'ChevronDown');
export const ChevronRight = createPikaComponent(ChevronRightIcon, 'ChevronRight');
export const ChevronLeft = createPikaComponent(ChevronLeftIcon, 'ChevronLeft');
export const ChevronUp = createPikaComponent(ChevronUpIcon, 'ChevronUp');
export const ArrowLeft = createPikaComponent(ArrowLeftIcon, 'ArrowLeft');
export const ArrowRight = createPikaComponent(ArrowRightIcon, 'ArrowRight');
export const ArrowDown = createPikaComponent(ArrowDownIcon, 'ArrowDown');
export const ArrowUp = createPikaComponent(ArrowUpIcon, 'ArrowUp');
export const ArrowDownLeft = createPikaComponent(ArrowDownIcon, 'ArrowDownLeft', 'rotate(45deg)');
export const ArrowUpRight = createPikaComponent(ArrowUpIcon, 'ArrowUpRight', 'rotate(45deg)');

// ---------------------------------------------------------------------------
// Controls & Actions
// ---------------------------------------------------------------------------
export const Settings = createPikaComponent(Settings01Icon, 'Settings');
export const MoreVertical = createPikaComponent(ThreeDotsMenuVerticalIcon, 'MoreVertical');
export const MoreHorizontal = createPikaComponent(ThreeDotsMenuHorizontalIcon, 'MoreHorizontal');
export const X = createPikaComponent(MultipleCrossCancelIcon, 'X');
export const Plus = createPikaComponent(PlusIcon, 'Plus');
export const Minus = createPikaComponent(MinusIcon, 'Minus');
export const Check = createPikaComponent(CheckTickCircleIcon, 'Check');
export const Trash2 = createPikaComponent(DeleteDustbin01Icon, 'Trash2');
export const Edit3 = createPikaComponent(PencilEditIcon, 'Edit3');
export const Type = createPikaComponent(PencilEditIcon, 'Type');
export const QrCode = createPikaComponent(QrIcon, 'QrCode');
export const Send = createPikaComponent(SendPlaneHorizontalIcon, 'Send');
export const Copy = createPikaComponent(CopyIcon, 'Copy');
export const Clipboard = createPikaComponent(ClipboardCheckIcon, 'Clipboard');
export const ClipboardPaste = createPikaComponent(ClipboardCheckIcon, 'ClipboardPaste');
export const Share2 = createPikaComponent(Share01Icon, 'Share2');
export const ExternalLink = createPikaComponent(ExternalLinkSquareIcon, 'ExternalLink');
export const Maximize2 = createPikaComponent(ExternalLinkSquareIcon, 'Maximize2');
export const LogOut = createPikaComponent(LogOutRightIcon, 'LogOut');
// Unlink / Unplug: LinkSlant with a diagonal cut strike clearly representing unpairing/disconnecting
export const Unlink = React.forwardRef<SVGSVGElement, IconProps>((props, ref) => {
  const { size = 20, color = 'currentColor', strokeWidth = 2, className, style, ...rest } = props;
  return (
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size, height: size, flexShrink: 0 }}>
      <PikaIcon ref={ref} icon={LinkSlantIcon} size={size} color={color} strokeWidth={strokeWidth} className={className} style={style} {...rest} />
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        <line x1="4" y1="4" x2="20" y2="20" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
      </svg>
    </span>
  );
});
Unlink.displayName = 'Unlink';
export const Unplug = Unlink;

// ---------------------------------------------------------------------------
// File & Content Types
// ---------------------------------------------------------------------------
export const Folder = createPikaComponent(FolderIcon, 'Folder');
export const File = createPikaComponent(FileIcon, 'File');
export const FileText = createPikaComponent(File02Icon, 'FileText');
export const FileCode = createPikaComponent(CodeIcon, 'FileCode');
export const FileArchive = createPikaComponent(Package01Icon, 'FileArchive');
export const FileSpreadsheet = createPikaComponent(File02Icon, 'FileSpreadsheet');
export const Package = createPikaComponent(Package01Icon, 'Package');
export const Image = createPikaComponent(PhotoImageIcon, 'Image');
export const Video = createPikaComponent(VideoCallIcon, 'Video');
export const Music = createPikaComponent(MusicBeamNoteIcon, 'Music');
export const Code2 = createPikaComponent(CodeIcon, 'Code2');

// ---------------------------------------------------------------------------
// Transfer & Cloud
// ---------------------------------------------------------------------------
export const UploadCloud = createPikaComponent(UploadBarUpIcon, 'UploadCloud');
export const FileUp = createPikaComponent(UploadUpIcon, 'FileUp');
export const Download = createPikaComponent(DownloadBarDownIcon, 'Download');

// ---------------------------------------------------------------------------
// Feedback, Progress & States
// ---------------------------------------------------------------------------
export const Loader2 = createPikaComponent(RefreshIcon, 'Loader2');
export const RefreshCw = createPikaComponent(RefreshIcon, 'RefreshCw');
export const RotateCcw = createPikaComponent(RefreshIcon, 'RotateCcw');
export const RotateCw = createPikaComponent(RefreshIcon, 'RotateCw', 'scaleX(-1)');
export const AlertCircle = createPikaComponent(AlertCircleIcon, 'AlertCircle');
export const AlertTriangle = createPikaComponent(AlertTriangleIcon, 'AlertTriangle');
export const HelpCircle = createPikaComponent(QuestionMarkCircleIcon, 'HelpCircle');
export const ShieldCheck = createPikaComponent(ShieldCheckIcon, 'ShieldCheck');
export const ShieldAlert = createPikaComponent(ShieldIcon, 'ShieldAlert');

// ---------------------------------------------------------------------------
// Media & Visibility
// ---------------------------------------------------------------------------
export const Play = createPikaComponent(PlayCircleIcon, 'Play');
export const Pause = createPikaComponent(PauseCircleIcon, 'Pause');
export const Eye = createPikaComponent(EyeOnIcon, 'Eye');
export const EyeOff = createPikaComponent(EyeOffIcon, 'EyeOff');
export const Volume2 = createPikaComponent(VolumeTwoIcon, 'Volume2');
export const VolumeX = createPikaComponent(SpeakerOnIcon, 'VolumeX');
export const ZoomIn = createPikaComponent(PlusIcon, 'ZoomIn');
export const ZoomOut = createPikaComponent(MinusIcon, 'ZoomOut');

// ---------------------------------------------------------------------------
// UI & Meta
// ---------------------------------------------------------------------------
export const Users = createPikaComponent(UserCircleIcon, 'Users');
export const Moon = createPikaComponent(MoonIcon, 'Moon');
export const Sun = createPikaComponent(SunIcon, 'Sun');
export const Mail = createPikaComponent(EnvelopeIcon, 'Mail');
export const MessageSquare = createPikaComponent(ChatIcon, 'MessageSquare');
export const Bug = createPikaComponent(TroubleshootIcon, 'Bug');
