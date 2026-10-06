/**
 * Seeded randomness for the hand simulator.
 *
 * A persona writing the same text with the same seed must produce the same strokes, byte for
 * byte, in Node and in every browser: tests depend on it, and so does any replay of an agent's
 * turn. `Math.random` cannot be seeded, so the simulator draws from its own generator.
 *
 * The generator is mulberry32 (Tommy Ettinger's 32-bit mixer, public domain): one 32-bit state
 * word, a period of 2^32, and output that passes the usual small-crush style checks, which is
 * more than enough for motor noise. Gaussian draws use the Box–Muller transform.
 *
 * Independent noise sources get independent *streams* ({@link Rng.fork}) so that turning one
 * source off does not shift the draws of the others: the tremor test runs the same seed with the
 * tremor amplitude at zero and non-zero, and the two runs differ only by the tremor.
 */

/** A deterministic stream of uniform and Gaussian draws. */
export class Rng {
  private s: number
  /** the seed this stream started from (forks derive from it, not from the current state) */
  readonly seed: number

  /** `seed` is any integer (only its low 32 bits matter). */
  constructor(seed: number) {
    this.seed = this.s = seed >>> 0
  }

  /** Uniform in [0, 1). */
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** Uniform in [a, b). */
  range(a: number, b: number): number {
    return a + (b - a) * this.next()
  }

  /** Normal with mean 0 and standard deviation `sd` (Box–Muller; one draw per call). */
  gauss(sd = 1): number {
    const u = Math.max(1e-12, this.next())
    const v = this.next()
    return sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  }

  /** True with probability `p`. */
  chance(p: number): boolean {
    return this.next() < p
  }

  /**
   * A new, independent stream named by `label`: the same parent seed and label always give the
   * same stream, whatever has been drawn from the parent so far.
   */
  fork(label: string): Rng {
    return new Rng(hash32(label) ^ Math.imul(this.seed, 0x9e3779b1))
  }
}

/** FNV-1a over UTF-16 code units: stable labels → stream seeds. */
export function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
