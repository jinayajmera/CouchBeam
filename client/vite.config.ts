import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // Reads ../.env so VITE_DEV_SERVER_TARGET can live in the single root .env
  const env = loadEnv(mode, '..', '');
  const target = env.VITE_DEV_SERVER_TARGET || 'http://localhost:8080';
  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/ws': { target, ws: true },
        '/api': target,
        '/healthz': target,
      },
    },
    build: { outDir: 'dist', sourcemap: true },
  };
});
