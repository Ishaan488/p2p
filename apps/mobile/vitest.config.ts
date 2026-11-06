import { defineConfig } from 'vitest/config';

// Unit tests of the pure TypeScript logic (no DOM needed). Kept separate from
// vite.config.ts so tests do not load the PWA/React build plugins.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
});
