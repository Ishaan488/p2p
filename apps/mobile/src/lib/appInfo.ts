/** Static facts about the app and its maker, shown on the About page. */
export const APP_VERSION = '1.0.0';
export const DEVELOPER_NAME = 'Ishaan';
export const REPO_URL = 'https://github.com/Ishaan488/p2p';
export const ISSUES_URL = `${REPO_URL}/issues/new`;
export const CONTACT_EMAIL = 'ishaanbajpai732004@gmail.com';

/** A mailto link with the app version prefilled so feedback arrives with context. */
export function feedbackMailto(platform: string): string {
  const subject = encodeURIComponent(`P2P Link feedback (v${APP_VERSION})`);
  const body = encodeURIComponent(`\n\n—\nP2P Link ${APP_VERSION} · ${platform}`);
  return `mailto:${CONTACT_EMAIL}?subject=${subject}&body=${body}`;
}
