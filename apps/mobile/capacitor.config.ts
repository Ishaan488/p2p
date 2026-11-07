import type { CapacitorConfig } from '@capacitor/cli';

const isLiveReload = process.env.CAPACITOR_LIVE_RELOAD === 'true';

const config: CapacitorConfig = {
  appId: 'io.p2plink.app',
  appName: 'P2P Link',
  webDir: 'dist',
  server: {
    ...(isLiveReload ? { url: 'http://localhost:5173' } : {}),
    cleartext: true,
    androidScheme: 'http'
  }
};

export default config;

