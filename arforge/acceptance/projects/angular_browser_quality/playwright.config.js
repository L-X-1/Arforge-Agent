const {defineConfig} = require("@playwright/test");

module.exports = defineConfig({
  testDir: "tests/playwright",
  webServer: {
    command: "node server.cjs",
    port: 4173,
    reuseExistingServer: false,
  },
  use: {
    baseURL: "http://127.0.0.1:4173",
    channel: "chrome",
    headless: true,
  },
});
