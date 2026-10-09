import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Modules read env at import time; give tests a harmless DB URL.
    env: { DATABASE_URL: 'postgresql://test@localhost:5432/test', NODE_ENV: 'test', LOG_LEVEL: 'error' },
  },
});
