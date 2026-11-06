import { describe, it, expect } from 'vitest';
import { getMediaKind, extractTextSnippet } from './telemetry';
import { pairWithApproval, pairWithQr } from './api';
import { backButtonManager } from './backButton';

describe('getMediaKind media classification', () => {
  it('classifies HEIC and HEIF photos as image alongside standard formats', () => {
    expect(getMediaKind('IMG_4021.HEIC')).toBe('image');
    expect(getMediaKind('burst.heif')).toBe('image');
    expect(getMediaKind('photo.webp')).toBe('image');
  });

  it('classifies PDF, audio, video, and code files accurately', () => {
    expect(getMediaKind('manual.pdf')).toBe('pdf');
    expect(getMediaKind('track.flac')).toBe('audio');
    expect(getMediaKind('clip.mp4')).toBe('video');
    expect(getMediaKind('App.tsx')).toBe('code');
    expect(getMediaKind('archive.zip')).toBe('other');
  });
});

describe('extractTextSnippet inline code preview', () => {
  it('extracts up to 10 lines for inline preview and preserves full content for small files', async () => {
    const content = Array.from({ length: 15 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const result = await extractTextSnippet(blob);

    expect(result.totalLines).toBe(15);
    expect(result.snippet.split('\n')).toHaveLength(10);
    expect(result.fullContent).toBe(content);
  });
});

describe('pairWithApproval & pairWithQr external AbortSignal cancellation', () => {
  it('aborts pairWithApproval immediately when the user cancels the pending approval', async () => {
    const controller = new AbortController();
    controller.abort(new Error('Pairing canceled by user'));

    await expect(
      pairWithApproval('10.0.0.5:8080', 'dev-1', 'Pixel 8', 'http', controller.signal)
    ).rejects.toThrow();
  });

  it('aborts pairWithQr immediately when an already-aborted signal is passed', async () => {
    const controller = new AbortController();
    controller.abort(new Error('Pairing canceled by user'));

    await expect(
      pairWithQr('10.0.0.5:8080', 'secret-token-123', 'dev-1', 'Pixel 8', 'http', undefined, controller.signal)
    ).rejects.toThrow();
  });
});

describe('backButtonManager LIFO dismissal', () => {
  it('dismisses the most recently registered overlay first and unregisters cleanly', () => {
    const closed: string[] = [];
    const unregisterSheet = backButtonManager.push(() => {
      closed.push('sheet');
      return true;
    });
    const unregisterDialog = backButtonManager.push(() => {
      closed.push('dialog');
      return true;
    });

    expect(backButtonManager.hasOpenModals()).toBe(true);
    expect(backButtonManager.popAndHandle()).toBe(true);
    expect(closed).toEqual(['dialog']);

    expect(backButtonManager.popAndHandle()).toBe(true);
    expect(closed).toEqual(['dialog', 'sheet']);

    unregisterDialog();
    unregisterSheet();
    expect(backButtonManager.hasOpenModals()).toBe(false);
  });
});
