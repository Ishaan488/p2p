const fs = require('fs');
const path = require('path');

// Simple in-memory IP sliding-window rate limiter per serverless instance
// Limits each IP to max 6 config fetches per 10 minutes
const RATE_WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 6;
const ipHits = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const entry = ipHits.get(ip);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    ipHits.set(ip, { windowStart: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_REQUESTS_PER_WINDOW;
}

function readKeyFromDotEnv() {
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '..', '.env'),
    path.resolve(__dirname, '..', '.env'),
    path.resolve(__dirname, '..', '..', '.env'),
  ];
  for (const filePath of candidates) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, 'utf8');
      const match = content.match(/^\s*WEB3FORMS_ACCESS_KEY\s*=\s*([^\r\n#]+)/m);
      if (match && match[1]) {
        const cleaned = match[1].trim().replace(/^['"]|['"]$/g, '');
        if (cleaned && cleaned !== 'your_web3forms_access_key_here') {
          return cleaned;
        }
      }
    } catch (_) {
      // ignore read errors
    }
  }
  return '';
}

module.exports = function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Validate Origin / Referer in production to prevent cross-site scraping
  const origin = req.headers.origin || '';
  const referer = req.headers.referer || '';
  const host = req.headers.host || '';
  const isLocal =
    host.startsWith('localhost') ||
    host.startsWith('127.0.0.1') ||
    origin.includes('localhost') ||
    origin.includes('127.0.0.1');

  if (!isLocal && origin && !origin.includes(host) && !referer.includes(host)) {
    return res.status(403).json({ error: 'Forbidden origin' });
  }

  const forwarded = req.headers['x-forwarded-for'];
  const clientIp =
    (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : '') ||
    (req.socket && req.socket.remoteAddress) ||
    'unknown';

  if (isRateLimited(clientIp)) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }

  const accessKey =
    (process.env.WEB3FORMS_ACCESS_KEY || '').trim() || readKeyFromDotEnv();

  if (!accessKey) {
    return res.status(503).json({ error: 'Feedback service not configured' });
  }

  return res.status(200).json({ accessKey });
};

