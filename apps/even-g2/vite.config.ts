import { appendFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

// Dev only: the app POSTs its console to /__log; lines land in .codrawer/logs/phone.log.
const phoneLog: Plugin = {
  name: 'codrawer-phone-log',
  configureServer(server) {
    const dir = resolve(__dirname, '../../.codrawer/logs')
    mkdirSync(dir, { recursive: true })
    server.middlewares.use('/__log', (req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        appendFileSync(resolve(dir, 'phone.log'), `${new Date().toISOString()} ${req.socket.remoteAddress} ${body}\n`)
        res.statusCode = 204
        res.end()
      })
    })
  },
}

// HMR must point at an address the phone can reach; set VITE_HMR_HOST=<lan-ip> for device testing.
const hmrHost = process.env.VITE_HMR_HOST
// A packaged .ehpk has no dev server to share a host with, so a production build may carry a
// router address: CODRAWER_WS=ws://<tablet-ip>:8577/ws/session1 pnpm ehpk (VITE_CODRAWER_WS is
// the older name). manifest.mjs whitelists the same origin in the package. By default there is
// none: the app then asks for the tablet's address on first run (src/phone/notices.ts).
// ?ws= and a remembered address still win at runtime.
const routerWs = process.env.CODRAWER_WS ?? process.env.VITE_CODRAWER_WS ?? ''
export default defineConfig({
  plugins: [phoneLog],
  // relative asset paths: the Even app serves the package from its own location
  base: './',
  define: { __CODRAWER_WS__: JSON.stringify(routerWs) },
  server: { host: true, port: 5188, strictPort: true, hmr: hmrHost ? { host: hmrHost } : undefined },
  build: { target: 'es2020' },
})
