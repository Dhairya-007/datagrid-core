import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Served from https://<user>.github.io/datagrid-core/, so every asset URL has
// to carry the repository name. The same base is used in development and in
// `vite preview`, so the only URL that ever has to work is the real one.
export default defineConfig({
  base: '/datagrid-core/',
  plugins: [react()],
  build: { target: 'es2020', sourcemap: true },
});
