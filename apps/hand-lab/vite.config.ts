import { defineConfig } from 'vite'

// The lab is a plain static page; the simulator comes from packages/hand as TypeScript source.
// Port: pass one (`pnpm --filter hand-lab dev --port 5197 --strictPort`); 5188 is the glasses
// app's, and 5190 and 5194–5196 are taken by other tools on the dev machine.
export default defineConfig({
  base: './',
  build: { target: 'es2022' },
})
