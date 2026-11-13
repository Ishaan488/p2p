import { describe, it, expect, beforeEach, vi } from 'vitest';
import { compareSemver, isNewer, checkForUpdates } from './updates';

describe('updates module', () => {
  describe('compareSemver', () => {
    it('correctly compares version components', () => {
      expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
      expect(compareSemver('1.0.1', '1.0.0')).toBe(1);
      expect(compareSemver('1.0.0', '1.0.1')).toBe(-1);
      expect(compareSemver('1.1.0', '1.0.9')).toBe(1);
      expect(compareSemver('2.0.0', '1.99.99')).toBe(1);
    });

    it('handles leading v prefix', () => {
      expect(compareSemver('v1.0.1', '1.0.0')).toBe(1);
      expect(compareSemver('v1.0.0', 'v1.0.0')).toBe(0);
      expect(compareSemver('1.0.0', 'v1.0.1')).toBe(-1);
    });

    it('handles short or irregular versions', () => {
      expect(compareSemver('1.1', '1.0.9')).toBe(1);
      expect(compareSemver('1.0', '1.0.0')).toBe(0);
      expect(compareSemver('1.0.1-rc1', '1.0.0')).toBe(1);
    });
  });

  describe('isNewer', () => {
    it('returns true only when latest is strictly higher than current', () => {
      expect(isNewer('1.0.2', '1.0.1')).toBe(true);
      expect(isNewer('1.1.0', '1.0.1')).toBe(true);
      expect(isNewer('2.0.0', '1.0.1')).toBe(true);
      expect(isNewer('1.0.1', '1.0.1')).toBe(false);
      expect(isNewer('1.0.0', '1.0.1')).toBe(false);
    });
  });

  describe('checkForUpdates network & cache', () => {
    const memoryStore = new Map<string, string>();
    beforeEach(() => {
      memoryStore.clear();
      vi.stubGlobal('localStorage', {
        getItem: (k: string) => memoryStore.get(k) ?? null,
        setItem: (k: string, v: string) => memoryStore.set(k, v),
        removeItem: (k: string) => memoryStore.delete(k),
        clear: () => memoryStore.clear(),
      });
      vi.restoreAllMocks();
    });

    it('fetches latest release from GitHub and returns update info', async () => {
      const mockRelease = {
        tag_name: 'v1.4.0',
        name: 'P2P Link v1.4.0',
        body: 'New features and improvements',
        published_at: '2026-11-08T00:00:00Z',
        html_url: 'https://github.com/Ishaan488/p2p/releases/tag/v1.4.0',
        assets: [
          {
            name: 'p2p-release.apk',
            size: 3800000,
            browser_download_url: 'https://github.com/Ishaan488/p2p/releases/download/v1.4.0/p2p-release.apk',
            content_type: 'application/vnd.android.package-archive',
          },
        ],
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockRelease,
      } as any);

      const result = await checkForUpdates(true);
      expect(result).not.toBeNull();
      expect(result?.latestVersion).toBe('1.4.0');
      expect(result?.hasUpdate).toBe(true);
      expect(result?.apkDownloadUrl).toBe('https://github.com/Ishaan488/p2p/releases/download/v1.4.0/p2p-release.apk');
      expect(result?.apkSize).toBe(3800000);
    });

    it('uses cached result when within throttle period', async () => {
      const cached = {
        hasUpdate: true,
        currentVersion: '1.0.1',
        latestVersion: '1.4.0',
        releaseName: 'P2P Link v1.4.0',
        releaseNotes: 'Cached notes',
        publishedAt: '2026-11-08T00:00:00Z',
        htmlUrl: 'https://github.com/Ishaan488/p2p/releases/tag/v1.4.0',
        apkDownloadUrl: 'https://example.com/p2p.apk',
      };

      localStorage.setItem('p2p_last_update_check_time', String(Date.now()));
      localStorage.setItem('p2p_last_update_check_result', JSON.stringify(cached));

      const fetchSpy = vi.fn();
      global.fetch = fetchSpy;

      const result = await checkForUpdates(false);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result?.latestVersion).toBe('1.4.0');
      expect(result?.hasUpdate).toBe(true);
    });
  });
});
