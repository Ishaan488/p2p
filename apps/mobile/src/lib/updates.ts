import { APP_VERSION, REPO_URL } from './appInfo';
import { downloadWithSystemManager } from './downloads';

export interface ReleaseAsset {
  name: string;
  size: number;
  browser_download_url: string;
  content_type: string;
}

export interface GitHubRelease {
  tag_name: string;
  name?: string;
  body?: string;
  published_at?: string;
  html_url?: string;
  assets?: ReleaseAsset[];
}

export interface UpdateCheckResult {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string;
  releaseName: string;
  releaseNotes: string;
  publishedAt: string;
  htmlUrl: string;
  apkDownloadUrl?: string;
  apkSize?: number;
}

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours throttle for automatic background checks
const STORAGE_KEY_TIME = 'p2p_last_update_check_time';
const STORAGE_KEY_RESULT = 'p2p_last_update_check_result';

const safeStorage = {
  getItem: (key: string): string | null => {
    try {
      return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    } catch {
      return null;
    }
  },
  setItem: (key: string, value: string): void => {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
    } catch {
      // ignore
    }
  },
};

/**
 * Compares two semver version strings (e.g. "v1.0.1" vs "1.1.0").
 * Returns:
 *   > 0 if a > b
 *   < 0 if a < b
 *   0 if a === b
 */
export function compareSemver(a: string, b: string): number {
  const clean = (v: string) => v.trim().replace(/^[vV]/, '').split('-')[0];
  const partsA = clean(a).split('.').map(n => parseInt(n, 10) || 0);
  const partsB = clean(b).split('.').map(n => parseInt(n, 10) || 0);

  const maxLen = Math.max(partsA.length, partsB.length, 3);
  for (let i = 0; i < maxLen; i++) {
    const numA = partsA[i] ?? 0;
    const numB = partsB[i] ?? 0;
    if (numA > numB) return 1;
    if (numA < numB) return -1;
  }
  return 0;
}

export function isNewer(latest: string, current: string = APP_VERSION): boolean {
  return compareSemver(latest, current) > 0;
}

/**
 * Checks GitHub for the latest release.
 * If force is false, respects the 4-hour background throttle to protect rate limits.
 */
export async function checkForUpdates(force = false): Promise<UpdateCheckResult | null> {
  const now = Date.now();

  if (!force) {
    try {
      const lastCheckStr = safeStorage.getItem(STORAGE_KEY_TIME);
      const cachedResultStr = safeStorage.getItem(STORAGE_KEY_RESULT);
      if (lastCheckStr && cachedResultStr) {
        const lastCheck = parseInt(lastCheckStr, 10);
        if (now - lastCheck < CHECK_INTERVAL_MS) {
          const cached = JSON.parse(cachedResultStr) as UpdateCheckResult;
          // Re-evaluate hasUpdate in case the installed version changed
          cached.currentVersion = APP_VERSION;
          cached.hasUpdate = isNewer(cached.latestVersion, APP_VERSION);
          return cached;
        }
      }
    } catch {
      // Storage unavailable; continue with network request
    }
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const res = await fetch('https://api.github.com/repos/Ishaan488/p2p/releases/latest', {
      headers: {
        Accept: 'application/vnd.github.v3+json',
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      return null;
    }

    const release: GitHubRelease = await res.json();
    const latestTag = (release.tag_name || '').replace(/^[vV]/, '');
    if (!latestTag) return null;

    const apkAsset = release.assets?.find(a => /\.apk$/i.test(a.name));

    const result: UpdateCheckResult = {
      hasUpdate: isNewer(latestTag, APP_VERSION),
      currentVersion: APP_VERSION,
      latestVersion: latestTag,
      releaseName: release.name || `P2P Link v${latestTag}`,
      releaseNotes: release.body || '',
      publishedAt: release.published_at || new Date().toISOString(),
      htmlUrl: release.html_url || `${REPO_URL}/releases/latest`,
      apkDownloadUrl: apkAsset?.browser_download_url,
      apkSize: apkAsset?.size,
    };

    try {
      safeStorage.setItem(STORAGE_KEY_TIME, String(now));
      safeStorage.setItem(STORAGE_KEY_RESULT, JSON.stringify(result));
    } catch {
      // ignore storage errors
    }

    return result;
  } catch (err) {
    console.warn('Update check failed:', err);
    return null;
  }
}

/**
 * Triggers the download and installation of an update APK.
 * Uses Android system DownloadManager when native, and falls back to opening in browser.
 */
export async function downloadAndInstallUpdate(apkUrl?: string, fallbackUrl?: string): Promise<boolean> {
  const url = apkUrl || fallbackUrl || `${REPO_URL}/releases/latest`;
  try {
    return await downloadWithSystemManager(
      url,
      'p2p-release.apk',
      'application/vnd.android.package-archive'
    );
  } catch {
    window.open(url, '_blank');
    return true;
  }
}
