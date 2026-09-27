import { defineConfig } from 'vite'

// HMR must point at an address the phone can reach; set VITE_HMR_HOST=<lan-ip> for device testing.
const hmrHost = process.env.VITE_HMR_HOST
export default defineConfig({
  server: { host: true, port: 5188, strictPort: true, hmr: hmrHost ? { host: hmrHost } : undefined },
  build: { target: 'es2020' },
})
