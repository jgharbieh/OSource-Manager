import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/web/ui',
  build: {
    outDir: '../../../dist/ui',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 7808,
    strictPort: false,
  },
});
