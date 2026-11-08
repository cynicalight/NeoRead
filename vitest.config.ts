import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Allow slower CI runners more time while keeping local feedback bounded.
    testTimeout: process.env.CI ? 20_000 : 10_000,
    server: {
      deps: {
        // Lobe Avatar imports UI modules that load Emoji Mart JSON through Vite.
        inline: [/@lobehub\/ui/, /@emoji-mart\/data/],
      },
    },
  },
});
