import { defineConfig } from "vite";
import webExtension from "vite-plugin-web-extension";

export default defineConfig({
  plugins: [
    webExtension({
      browser: "chrome",
      manifest: "src/manifest.json",
    }),
  ],
  build: {
    outDir: "dist",
    sourcemap: true,
    emptyOutDir: true,
  },
});
