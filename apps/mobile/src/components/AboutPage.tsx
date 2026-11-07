import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Bug, Code2, ExternalLink, Mail, MessageSquare, RefreshCw } from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { backButtonManager } from '../lib/backButton';
import { APP_VERSION, CONTACT_EMAIL, DEVELOPER_NAME, ISSUES_URL, REPO_URL, feedbackMailto } from '../lib/appInfo';
import { BrandLogo } from './BrandLogo';
import { checkForUpdates, downloadAndInstallUpdate, type UpdateCheckResult } from '../lib/updates';

/** About: who made it, where the code lives, updates, and the easiest ways to say something back. */
export const AboutPage: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => backButtonManager.push(() => { closeRef.current(); return true; }), []);

  const [checking, setChecking] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [checkStatus, setCheckStatus] = useState<string>('Tap to check GitHub releases');

  const handleCheckUpdates = async () => {
    if (checking) return;
    setChecking(true);
    setCheckStatus('Checking GitHub...');
    try {
      const res = await checkForUpdates(true);
      if (!res) {
        setCheckStatus('Unable to reach GitHub');
      } else {
        setUpdateInfo(res);
        setCheckStatus(res.hasUpdate ? `Version ${res.latestVersion} is available!` : `You're on the latest version`);
      }
    } catch {
      setCheckStatus('Check failed');
    } finally {
      setChecking(false);
    }
  };

  const handleDownload = async () => {
    if (!updateInfo) return;
    setDownloading(true);
    try {
      await downloadAndInstallUpdate(updateInfo.apkDownloadUrl, updateInfo.htmlUrl);
    } finally {
      setTimeout(() => setDownloading(false), 2000);
    }
  };

  const platform = Capacitor.isNativePlatform() ? Capacitor.getPlatform() : 'web';

  return (
    <div className="page about-page" role="dialog" aria-modal="true" aria-labelledby="about-heading">
      <div className="page-bar">
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Back"><ArrowLeft size={22} /></button>
        <h2 id="about-heading" className="page-bar-title">About</h2>
      </div>

      <div className="scroll" style={{ paddingBottom: 'calc(var(--safe-bottom) + var(--s-8))' }}>
        <div className="about-hero">
          <span className="about-mark"><BrandLogo size={30} connected={false} /></span>
          <h3 className="about-name">P2P Link</h3>
          <p className="about-sub">Version {APP_VERSION}</p>
          <p className="about-line">Fast, private file sharing between your phone and computer. No cloud, no accounts.</p>
        </div>

        <div className="section-label">Updates</div>
        <div className="group settings-group">
          <div className="row" style={{ cursor: 'pointer' }} onClick={handleCheckUpdates}>
            <RefreshCw size={20} className={`row-icon${checking ? ' spin' : ''}`} />
            <span className="row-main">
              <span className="row-title">{updateInfo?.hasUpdate ? `Update to v${updateInfo.latestVersion}` : 'Check for updates'}</span>
              <span className="row-sub">{checkStatus}</span>
            </span>
            {updateInfo?.hasUpdate ? (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={downloading}
                onClick={(e) => {
                  e.stopPropagation();
                  handleDownload();
                }}
              >
                {downloading ? 'Downloading…' : 'Install Update'}
              </button>
            ) : (
              <span className="row-value">v{APP_VERSION}</span>
            )}
          </div>
          {updateInfo?.hasUpdate && updateInfo.releaseNotes && (
            <div className="row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '4px' }}>
              <span className="row-sub" style={{ whiteSpace: 'pre-line', fontSize: '12px', opacity: 0.85, maxHeight: '120px', overflowY: 'auto' }}>
                {updateInfo.releaseNotes}
              </span>
            </div>
          )}
        </div>

        <div className="section-label">Developer</div>
        <div className="group settings-group">
          <div className="row">
            <span className="row-main">
              <span className="row-title">Built by {DEVELOPER_NAME}</span>
              <span className="row-sub">Independent, open source</span>
            </span>
          </div>
          <a className="row" href={REPO_URL} target="_blank" rel="noreferrer">
            <Code2 size={20} className="row-icon" />
            <span className="row-main"><span className="row-title">Source code</span><span className="row-sub">github.com/Ishaan488/p2p</span></span>
            <ExternalLink size={16} className="row-chevron" />
          </a>
          <a className="row" href={`mailto:${CONTACT_EMAIL}`}>
            <Mail size={20} className="row-icon" />
            <span className="row-main"><span className="row-title">Email</span><span className="row-sub">{CONTACT_EMAIL}</span></span>
          </a>
        </div>

        <div className="section-label">Feedback</div>
        <div className="group settings-group">
          <a className="row" href={feedbackMailto(platform)}>
            <MessageSquare size={20} className="row-icon" />
            <span className="row-main"><span className="row-title">Send feedback</span><span className="row-sub">Ideas, praise, anything on your mind</span></span>
          </a>
          <a className="row" href={ISSUES_URL} target="_blank" rel="noreferrer">
            <Bug size={20} className="row-icon" />
            <span className="row-main"><span className="row-title">Report a problem</span><span className="row-sub">Opens a GitHub issue</span></span>
            <ExternalLink size={16} className="row-chevron" />
          </a>
        </div>

        <p className="about-thanks">Thanks for using P2P Link. Every message gets read.</p>
      </div>
    </div>
  );
};

export default AboutPage;
