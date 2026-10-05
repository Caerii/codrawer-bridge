/**
 * Wrapping text for the glasses, which wrap it themselves and tell us nothing.
 *
 * The text container uses a proportional font and offers no measurement API. The glasses wrap
 * at the container's width (~560 px usable), and every row they wrap onto eats a row of our
 * budget, which would push the input line off the bottom. So we wrap first, conservatively, at
 * {@link COLS} characters, and fill rows from the bottom up
 * (hud/render.ts) so the line being typed is always the last visible row. Pure.
 */

/** Characters per row we allow ourselves: safely under what fits in ~560 px. */
export const COLS = 44

/** Split `s` into rows of at most `cols` characters, at a space when one falls past half a row. */
export function wrapLine(s: string, cols = COLS): string[] {
  const out: string[] = []
  let rest = s
  while (rest.length > cols) {
    let cut = rest.lastIndexOf(' ', cols)
    if (cut < cols * 0.5) cut = cols
    out.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  out.push(rest)
  return out
}
