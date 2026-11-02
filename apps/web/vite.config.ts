import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({ plugins: [react(), tailwindcss()], server: { port: 5173, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:17840' }, '/pub': { target: 'http://127.0.0.1:17840' } } }, build: { target: 'es2022', rollupOptions: { input: { main: 'index.html', migration: 'migration.html' } } } });
