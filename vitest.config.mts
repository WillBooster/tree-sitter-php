import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

const BrowserTests = ['test/e2e/browser.test.ts'];
const PerformanceTests = ['test/unit/performance.test.ts'];

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
          exclude: [...BrowserTests, ...PerformanceTests],
        },
      },
      {
        test: {
          name: 'performance',
          include: PerformanceTests,
          // Compile Wasm with the optimizing compiler immediately: background tier-up can otherwise
          // change execution speed between the small and large inputs despite measuring thread CPU time.
          execArgv: ['--no-liftoff'],
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
