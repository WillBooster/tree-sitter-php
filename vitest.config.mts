import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

const BrowserTests = ['test/e2e/browser.test.ts'];

export default defineConfig({
  test: {
    // tsconfig.json declares the `vitest/globals` types, so the runner must provide those globals.
    globals: true,
    projects: [
      {
        test: {
          name: 'node',
          globalSetup: 'test/helpers/installCli.ts',
          include: ['test/{unit,e2e}/**/*.test.ts'],
          exclude: BrowserTests,
        },
      },
      {
        test: {
          name: 'browser',
          include: BrowserTests,
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});
