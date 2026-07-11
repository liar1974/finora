import { defineConfig } from 'vitest/config';

// Unit/integration tests live in test/ and are named *.test.ts. Scoping the
// include here keeps Vitest from picking up the Playwright E2E specs under e2e/
// (*.spec.ts), which run under a different runner.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
