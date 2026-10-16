import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: process.env.WEB_HOST ?? '0.0.0.0',
    allowedHosts: ['childpsych-previsit-a001.vip.cpolar.cn'],
    port: 5176,
    strictPort: true,
    proxy: {
      '/health': {
        target: 'http://127.0.0.1:4176',
        changeOrigin: true,
      },
      '/api': {
        target: 'http://127.0.0.1:4176',
        changeOrigin: true,
      },
    },
  },
});
