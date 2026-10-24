// Only the bridge's own tests: vendored agent skills under .claude/ ship their own suites.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
