import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/http/web',
  plugins: [react()],
  build: {
    outDir: '../../../dist/http/web',
    emptyOutDir: true,
  },
});
