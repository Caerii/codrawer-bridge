import { defineConfig } from 'vite'

// HMR must point at an address the phone can reach; set VITE_HMR_HOST=<lan-ip> for device testing.
const hmrHost = process.env.VITE_HMR_HOST
// A packaged .ehpk has no dev server to share a host with, so the production build bakes in the
// router address. Override with VITE_CODRAWER_WS=ws://<router-ip>:8577/ws/<session> pnpm ehpk;
// the origin must also be whitelisted in app.json. ?ws= still wins at runtime.
// Default: the router inside the tablet's bridge (bridge/remarkable/boot/bridge.env.example).
const routerWs = process.env.VITE_CODRAWER_WS ?? 'ws://192.168.50.156:8577/ws/session1'
export default defineConfig({
  // relative asset paths: the Even app serves the package from its own location
  base: './',
  define: { __CODRAWER_WS__: JSON.stringify(routerWs) },
  server: { host: true, port: 5188, strictPort: true, hmr: hmrHost ? { host: hmrHost } : undefined },
  build: { target: 'es2020' },
})
