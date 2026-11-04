import { defineConfig } from "vite";
export default defineConfig({
  root: "apps/studio",
  build: { outDir: "../../dist", emptyOutDir: true },
  server: { host: "127.0.0.1" },
});
