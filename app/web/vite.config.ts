import { defineConfig } from 'vite';

const backend = `http://${process.env.HOST ?? '127.0.0.1'}:${process.env.PORT ?? '3000'}`;

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true, // start.bat wartet fest auf 5173 und öffnet sonst eine fremde App
    // Host unverändert durchreichen: die CSRF-Sperre im Backend vergleicht Origin und Host
    proxy: { '/api': { target: backend, changeOrigin: false } },
  },
});
