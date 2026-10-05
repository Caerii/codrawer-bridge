// The Even Hub manifest a package is built with: app.json plus the network origins of this build.
//
// The Even app enforces app.json's network whitelist inside the WebView: a fetch or WebSocket to an
// origin that is not listed is blocked before any traffic leaves the phone. Entries are full
// origins (`ws://192.168.1.20:8577`); bare hosts, wildcards and address ranges are not supported
// (hub.evenrealities.com/docs/build/networking, read 2026-10-05). So a packaged .ehpk can only
// ever reach the routers it was built for, and the tracked app.json lists none but localhost: no
// one's home network is baked into the repository.
//
// This script adds, for each router given at build time, its ws:// origin and the matching
// http:// one (the router's HTTP endpoints share the port), and writes app.packed.json, which
// `pnpm ehpk` packs instead of app.json:
//
//   CODRAWER_WS=ws://<tablet-ip>:8577/ws/session1 pnpm ehpk     the router the app starts with
//   CODRAWER_WHITELIST=<url>,<url> pnpm ehpk                     further routers it may be pointed at
//
// The first-run prompt and "Tablet address…" (src/phone/notices.ts) can only connect to an address
// whose origin is in the package; the dev server (`pnpm dev` + QR) is the way to try any address.
import { readFileSync, writeFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync(new URL('./app.json', import.meta.url), 'utf8'))
const network = manifest.permissions.find((p) => p.name === 'network')
const wanted = [process.env.CODRAWER_WS ?? process.env.VITE_CODRAWER_WS ?? '', ...(process.env.CODRAWER_WHITELIST ?? '').split(',')]

for (const raw of wanted.map((s) => s.trim()).filter(Boolean)) {
  let u
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `ws://${raw}`)
  } catch {
    console.error(`manifest: not a URL: ${raw}`)
    process.exit(1)
  }
  const secure = u.protocol === 'wss:' || u.protocol === 'https:'
  const host = u.port ? `${u.hostname}:${u.port}` : `${u.hostname}:8577`
  for (const origin of [`${secure ? 'wss' : 'ws'}://${host}`, `${secure ? 'https' : 'http'}://${host}`]) {
    if (!network.whitelist.includes(origin)) network.whitelist.push(origin)
  }
}

writeFileSync(new URL('./app.packed.json', import.meta.url), JSON.stringify(manifest, null, 2) + '\n')
console.log('manifest: network whitelist', network.whitelist.join(' '))
