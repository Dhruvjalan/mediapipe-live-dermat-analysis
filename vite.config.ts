import { defineConfig } from 'vite';

export default defineConfig({
  base: '/',

  plugins: [
    {
      name: 'disable-mediapipe-sourcemap',
      enforce: 'pre',
      transform(code, id) {
        if (id.includes('@mediapipe/tasks-vision')) {
          return {
            code: code.replace(/\/\/# sourceMappingURL=.*/g, ''),
            map: null
          };
        }
      }
    }
  ],
  optimizeDeps: {
    exclude: [
      '@mediapipe/tasks-vision',
      '@mediapipe/tasks-audio',
      '@mediapipe/tasks-text'
    ]
  },
  worker: {
    format: 'es'
  },
  build: {
    sourcemap: false,
  },
  server: {
    port: 5174,
    strictPort: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    }
  },
  preview: {
    port: 5174,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    }
  }
});