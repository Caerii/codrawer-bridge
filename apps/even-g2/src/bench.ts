/**
 * On-device latency benchmark for the Even G2 image/text update path.
 *
 * Load the app with `?bench=1`. It rebuilds the page for each configuration,
 * pushes N frames of changing content through `updateImageRawData`, and
 * reports min / median round trip per configuration in the text container,
 * the DOM status and the console. `?bench=0` (or a normal load) restores the
 * app. The goal is to find where the fixed cost lives:
 *
 *   - size sweep      → is it bytes over BLE?
 *   - base64 vs array → is it JSON marshaling across the WebView bridge?
 *   - text-only       → what does the cheapest possible update cost?
 */
import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import { packGray4, toBase64 } from './strokes'

interface Config {
  label: string
  w: number
  h: number
  fmt: 'gray8' | 'gray4'
  enc: 'array' | 'b64'
  text?: boolean
}

const CONFIGS: Config[] = [
  { label: 'text-only', w: 20, h: 20, fmt: 'gray8', enc: 'b64', text: true },
  { label: '20x20 g8 b64', w: 20, h: 20, fmt: 'gray8', enc: 'b64' },
  { label: '64x32 g8 b64', w: 64, h: 32, fmt: 'gray8', enc: 'b64' },
  { label: '128x64 g8 b64', w: 128, h: 64, fmt: 'gray8', enc: 'b64' },
  { label: '128x64 g8 arr', w: 128, h: 64, fmt: 'gray8', enc: 'array' },
  { label: '128x64 g4 b64', w: 128, h: 64, fmt: 'gray4', enc: 'b64' },
  { label: '288x144 g8 b64', w: 288, h: 144, fmt: 'gray8', enc: 'b64' },
]
const FRAMES = 6
const IMG_ID = 1
const TEXT_ID = 2

function frame(w: number, h: number, i: number): Uint8Array {
  // a moving bar on black: changes every frame, compresses like real ink
  const g = new Uint8Array(w * h)
  const x = Math.floor(((i * 7) % Math.max(1, w - 4)) + 2)
  for (let y = 0; y < h; y++) {
    for (let dx = -1; dx <= 1; dx++) g[y * w + x + dx] = 255
  }
  return g
}

async function buildPage(b: EvenAppBridge, w: number, h: number, status: string): Promise<boolean> {
  const page = {
    containerTotalNum: 2,
    imageObject: [new ImageContainerProperty({ xPosition: 8, yPosition: 4, width: w, height: h, containerID: IMG_ID, containerName: 'bench', zOrderIndex: 1 })],
    textObject: [
      new TextContainerProperty({
        xPosition: 8,
        yPosition: 156,
        width: 560,
        height: 128,
        containerID: TEXT_ID,
        containerName: 'status',
        content: status,
        textColor: 3,
        isEventCapture: 1,
        zOrderIndex: 2,
      }),
    ],
  }
  const r = await b.createStartUpPageContainer(new CreateStartUpPageContainer(page))
  if (r === StartUpPageCreateResult.success) return true
  return b.rebuildPageContainer(new RebuildPageContainer(page))
}

function stats(ms: number[]): { min: number; med: number } {
  const s = [...ms].sort((a, b) => a - b)
  return { min: Math.round(s[0] ?? 0), med: Math.round(s[Math.floor(s.length / 2)] ?? 0) }
}

export async function runBench(b: EvenAppBridge, report: (lines: string[]) => void): Promise<void> {
  const lines: string[] = ['bench: running…']
  report(lines)
  const results: string[] = []
  for (const c of CONFIGS) {
    const ok = await buildPage(b, c.w, c.h, `bench: ${c.label}`)
    if (!ok) {
      results.push(`${c.label}: page rebuild failed`)
      continue
    }
    await new Promise((r) => setTimeout(r, 400))
    const times: number[] = []
    for (let i = 0; i < FRAMES; i++) {
      const t0 = performance.now()
      try {
        if (c.text) {
          await b.textContainerUpgrade(new TextContainerUpgrade({ containerID: TEXT_ID, containerName: 'status', content: `bench: text ${i} ${'·'.repeat(i)}` }))
        } else {
          const g8 = frame(c.w, c.h, i)
          const bytes = c.fmt === 'gray4' ? packGray4(g8) : g8
          const imageData = c.enc === 'b64' ? toBase64(bytes) : bytes
          const r = await b.updateImageRawData(new ImageRawDataUpdate({ containerID: IMG_ID, containerName: 'bench', imageData }))
          if (String(r) !== 'success') {
            results.push(`${c.label}: ${String(r)}`)
            break
          }
        }
      } catch (e) {
        results.push(`${c.label}: threw ${String(e).slice(0, 40)}`)
        break
      }
      times.push(performance.now() - t0)
    }
    if (times.length) {
      const { min, med } = stats(times)
      const bytes = c.text ? 0 : (c.fmt === 'gray4' ? (c.w * c.h) / 2 : c.w * c.h)
      results.push(`${c.label}: min ${min} med ${med} ms (${bytes} B)`)
    }
    console.log('[bench]', results[results.length - 1])
    report(['bench:', ...results])
  }
  results.push('done — load ?bench=0 to return')
  report(['bench:', ...results])
  console.log('[bench] results\n' + results.join('\n'))
  try {
    localStorage.setItem('codrawer:bench-results', JSON.stringify(results))
  } catch {
    /* ignore */
  }
}
