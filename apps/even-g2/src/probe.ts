/**
 * On-device link probe (?probe=1): times image and text updates on the app's own page, in
 * isolation, to find where the per-call cost comes from. Unlike bench.ts it never tears the page
 * down (shutDownPageContainer exits the app on the device), so it can run on real glasses.
 *
 * Results go to the console (in dev builds that is .codrawer/logs/phone.log on the desktop) and
 * to the status callback. Each case: min / median / p90 ms over N calls.
 */
import { ImageRawDataUpdate, TextContainerUpgrade, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { toPng1Bytes, toPngBytes } from './strokes'

interface Target {
  id: number
  name: string
  w: number
  h: number
}

function frameCanvas(w: number, h: number, i: number): HTMLCanvasElement {
  // a moving diagonal stroke on black: changes every frame, compresses like real ink
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')!
  g.fillStyle = '#000'
  g.fillRect(0, 0, w, h)
  g.strokeStyle = '#fff'
  g.lineWidth = 2
  g.beginPath()
  const x = (i * 9) % w
  g.moveTo(x, 4)
  g.lineTo((x + w / 3) % w, h - 4)
  g.stroke()
  return c
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function summary(label: string, ms: number[], bytes: number): string {
  const s = [...ms].sort((a, b) => a - b)
  const q = (p: number) => Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))])
  return `${label}: min ${Math.round(s[0])} med ${q(0.5)} p90 ${q(0.9)} ms (${bytes} B, n=${s.length})`
}

export async function runProbe(b: EvenAppBridge, loupe: Target, canvas: Target, textId: number, report: (lines: string[]) => void) {
  const out: string[] = []
  const say = (line: string) => {
    out.push(line)
    console.log('[probe]', line)
    report(['probe:', ...out])
  }

  async function images(label: string, t: Target, enc: 'png1' | 'png', n: number, gapMs: number) {
    const ms: number[] = []
    let bytes = 0
    for (let i = 0; i < n; i++) {
      const c = frameCanvas(t.w, t.h, i)
      const data = enc === 'png1' ? toPng1Bytes(c.getContext('2d')!, t.w, t.h) : toPngBytes(c)
      bytes = data.length
      const t0 = performance.now()
      const r = await b.updateImageRawData(new ImageRawDataUpdate({ containerID: t.id, containerName: t.name, imageData: data }))
      ms.push(performance.now() - t0)
      if (String(r) !== 'success' && i === 0) say(`${label}: result ${String(r)}`)
      if (gapMs) await sleep(gapMs)
    }
    say(summary(label, ms, bytes))
  }

  async function texts(label: string, n: number) {
    const ms: number[] = []
    for (let i = 0; i < n; i++) {
      const t0 = performance.now()
      await b.textContainerUpgrade(new TextContainerUpgrade({ containerID: textId, containerName: 'status', content: `probe ${label} ${i}` }))
      ms.push(performance.now() - t0)
    }
    say(summary(label, ms, 0))
  }

  say('start (draw nothing while it runs, ~1 min)')
  await sleep(1500)
  await images('loupe png1 back-to-back', loupe, 'png1', 20, 0)
  await images('loupe png back-to-back', loupe, 'png', 20, 0)
  await images('loupe png1 gap 150ms', loupe, 'png1', 15, 150)
  await images('loupe png1 gap 500ms', loupe, 'png1', 10, 500)
  await texts('text back-to-back', 15)
  await images('canvas png1 back-to-back', canvas, 'png1', 10, 0)
  await images('canvas png back-to-back', canvas, 'png', 10, 0)
  say('done')
}
