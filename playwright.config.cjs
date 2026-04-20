const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/e2e',
  timeout: 45000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:3100',
    headless: true
  },
  webServer: {
    command: 'node tests/e2e/mock-server.js',
    url: 'http://127.0.0.1:3100',
    reuseExistingServer: true,
    timeout: 120000
  }
});
