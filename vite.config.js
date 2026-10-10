import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  root: 'extension',
  base: './',
  build: {
    outDir: '../dist/extension',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        panel: resolve('extension/panel.html'),
        background: resolve('extension/background.js'),
      },
      output: { entryFileNames: '[name].js', chunkFileNames: 'assets/[name]-[hash].js' },
    },
  },
});
