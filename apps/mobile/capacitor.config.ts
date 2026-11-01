import type { CapacitorConfig } from '@capacitor/cli';

const isLiveReload = process.env.CAPACITOR_LIVE_RELOAD === 'true';

const config: CapacitorConfig = {
  appId: 'com.example.app',
  appName: 'p2p-mobile',
  webDir: 'dist',
  server: {
    ...(isLiveReload ? { url: 'http://localhost:5173' } : {}),
    cleartext: true,
    androidScheme: 'http'
  }
};

export default config;

