import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 3000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('rapier')) return 'rapier';
          if (id.includes('node_modules/three')) return 'three';
        },
      },
    },
  },
});
