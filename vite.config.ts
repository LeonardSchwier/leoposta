import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { resolveDevToken } from './scripts/dev-token.js'

// Make the frontend agree with the backend's dev token out of the box so the
// user can run `npm run dev` and `npm run server` in two terminals without
// touching env vars. If VITE_LEOPOSTA_TOKEN is already set (shell or a prior
// .env load wins later), this is a no-op.
if (!process.env.VITE_LEOPOSTA_TOKEN) {
  const t = resolveDevToken({ persist: true })
  if (t) process.env.VITE_LEOPOSTA_TOKEN = t
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    svelte(),
    tailwindcss(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'icons.svg'],
      manifest: {
        name: 'Leoposta',
        short_name: 'Mail',
        description: 'A modern mail client with a clean, native-mail UX',
        theme_color: '#faf9f6',
        background_color: '#faf9f6',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        navigateFallback: '/index.html',
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: /^\/api\/.*/i,
            handler: 'NetworkOnly'
          },
          {
            urlPattern: ({ request, sameOrigin }) => sameOrigin && (request.destination === 'image' || request.destination === 'font' || request.destination === 'style'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'static-resources',
              expiration: { maxEntries: 100, maxAgeSeconds: 30 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] }
            }
          },
          {
            urlPattern: ({ request, sameOrigin }) => sameOrigin && request.destination === 'script',
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'scripts',
              expiration: { maxEntries: 50, maxAgeSeconds: 7 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] }
            }
          }
        ]
      }
    })
  ],
  server: {
    port: 3000,
    proxy: {
      '/api': process.env.LEOPOSTA_API_URL || 'http://localhost:3001'
    }
  }
})
