const { defineConfig } = require('@playwright/test');

const e2eBaseUrl = process.env.E2E_BASE_URL || 'https://calendar-backend-production-a5ad.up.railway.app';

module.exports = defineConfig({
  testDir: './tests/e2e',
  timeout: 45000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: e2eBaseUrl,
    headless: true
  }
});
