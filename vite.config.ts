import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  define: { __BUILD_TIME__: JSON.stringify(new Date().toISOString().slice(0, 16)) },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Phone notifications (public/push-sw.js).
      workbox: { importScripts: ['/push-sw.js'], navigateFallbackDenylist: [/^\/sitemap\.xml$/, /^\/robots\.txt$/] },
      manifest: {
        name: 'BiteBY',
        short_name: 'BiteBY',
        description: 'Real food. Real people. Homemade food from local cooks.',
        theme_color: '#FFC72C',
        background_color: '#FFFDF7',
        start_url: '/',
        display: 'standalone',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
})
