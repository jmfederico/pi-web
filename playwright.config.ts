import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./test-fixtures/browser",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  workers: 2,
  use: { baseURL: "http://127.0.0.1:8516", trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    { name: "webkit-phone", testMatch: "**/scroll-stability.spec.ts", use: { ...devices["iPhone 14"] } },
    { name: "touch", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: "npm exec -- vite build --config test-fixtures/browser/vite.config.ts && npm exec -- vite preview --config test-fixtures/browser/vite.config.ts --host 127.0.0.1 --port 8516 --strictPort",
    url: "http://127.0.0.1:8516/overlays.html",
    reuseExistingServer: false,
  },
});
