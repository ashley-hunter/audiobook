/* Bedtime - the view tests run in a real browser, not a fake one.
 *
 * Vitest's browser mode drives Chromium through Playwright, which is already
 * here for the end-to-end suites. That keeps the fast layer honest: the same
 * engine, the same DOM, no third rendering environment to disagree with the
 * phone.
 *
 * Only *.browser.test.js is collected. The end-to-end suites are plain node
 * scripts and run themselves.
 */
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

export default defineConfig({
  test: {
    include: ['test/**/*.browser.test.js'],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      screenshotFailures: false,
      instances: [{ browser: 'chromium' }],
    },
  },
});
