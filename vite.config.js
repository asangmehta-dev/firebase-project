import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          'firebase-vendor': [
            'firebase/app',
            'firebase/auth',
            'firebase/database',
            'firebase/functions',
            'firebase/storage',
          ],
        },
      },
    },
    chunkSizeWarningLimit: 800,
  },
})
