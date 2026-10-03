/**
 * A small document editor: lines + cursor, plain text (markdown as text).
 *
 * Pure and testable; nothing here knows about the glasses. `view()` returns
 * the rows to show for a viewport of `rows` × `cols`, wrapped the same way the
 * transcript wraps, with the cursor glyph inserted and the viewport scrolled
 * so the cursor row is always visible.
 */

export interface EditorView {
  rows: string[]
  cursorRow: number // index within rows
  line: number // 1-based logical line
  col: number // 1-based column within the logical line
  totalLines: number
}

export class Editor {
  lines: string[] = ['']
  row = 0
  col = 0
  dirty = false
  private viewTop = 0 // first visual row shown (in wrapped-row space)

  text(): string {
    return this.lines.join('\n')
  }

  setText(text: string) {
    this.lines = text.replace(/\r\n/g, '\n').split('\n')
    if (this.lines.length === 0) this.lines = ['']
    this.row = Math.min(this.row, this.lines.length - 1)
    this.col = Math.min(this.col, this.lines[this.row].length)
    this.dirty = false
  }

  insert(s: string) {
    const line = this.lines[this.row]
    this.lines[this.row] = line.slice(0, this.col) + s + line.slice(this.col)
    this.col += s.length
    this.dirty = true
  }

  newline() {
    const line = this.lines[this.row]
    const before = line.slice(0, this.col)
    const after = line.slice(this.col)
    // keep a markdown list prefix going
    const m = /^(\s*(?:[-*+]|\d+\.)\s+)/.exec(before)
    const prefix = m && after === '' && before.trim() !== m[1].trim() ? m[1] : ''
    this.lines.splice(this.row, 1, before, prefix + after)
    this.row++
    this.col = prefix.length
    this.dirty = true
  }

  backspace() {
    if (this.col > 0) {
      const line = this.lines[this.row]
      this.lines[this.row] = line.slice(0, this.col - 1) + line.slice(this.col)
      this.col--
    } else if (this.row > 0) {
      const prev = this.lines[this.row - 1]
      this.col = prev.length
      this.lines.splice(this.row - 1, 2, prev + this.lines[this.row])
      this.row--
    } else {
      return
    }
    this.dirty = true
  }

  delete() {
    const line = this.lines[this.row]
    if (this.col < line.length) {
      this.lines[this.row] = line.slice(0, this.col) + line.slice(this.col + 1)
    } else if (this.row < this.lines.length - 1) {
      this.lines.splice(this.row, 2, line + this.lines[this.row + 1])
    } else {
      return
    }
    this.dirty = true
  }

  left() {
    if (this.col > 0) this.col--
    else if (this.row > 0) {
      this.row--
      this.col = this.lines[this.row].length
    }
  }

  right() {
    if (this.col < this.lines[this.row].length) this.col++
    else if (this.row < this.lines.length - 1) {
      this.row++
      this.col = 0
    }
  }

  up() {
    if (this.row > 0) {
      this.row--
      this.col = Math.min(this.col, this.lines[this.row].length)
    } else this.col = 0
  }

  down() {
    if (this.row < this.lines.length - 1) {
      this.row++
      this.col = Math.min(this.col, this.lines[this.row].length)
    } else this.col = this.lines[this.row].length
  }

  home() {
    this.col = 0
  }

  end() {
    this.col = this.lines[this.row].length
  }

  wordLeft() {
    if (this.col === 0) return this.left()
    const line = this.lines[this.row]
    let c = this.col - 1
    while (c > 0 && line[c - 1] === ' ') c--
    while (c > 0 && line[c - 1] !== ' ') c--
    this.col = c
  }

  wordRight() {
    const line = this.lines[this.row]
    if (this.col >= line.length) return this.right()
    let c = this.col
    while (c < line.length && line[c] !== ' ') c++
    while (c < line.length && line[c] === ' ') c++
    this.col = c
  }

  pageUp(n: number) {
    for (let i = 0; i < n; i++) this.up()
  }

  pageDown(n: number) {
    for (let i = 0; i < n; i++) this.down()
  }

  /** Wrap one logical line into visual segments of at most `cols` characters, at spaces when possible. */
  static wrap(line: string, cols: number): { text: string; start: number }[] {
    if (line.length <= cols) return [{ text: line, start: 0 }]
    const out: { text: string; start: number }[] = []
    let start = 0
    while (line.length - start > cols) {
      let cut = line.lastIndexOf(' ', start + cols)
      if (cut <= start + cols * 0.5) cut = start + cols
      else cut += 1 // keep the space with the first segment
      out.push({ text: line.slice(start, cut), start })
      start = cut
    }
    out.push({ text: line.slice(start), start })
    return out
  }

  view(rows: number, cols: number, cursor = '▌'): EditorView {
    // Build all visual rows, remembering which one holds the cursor.
    const visual: string[] = []
    let cursorRow = 0
    for (let r = 0; r < this.lines.length; r++) {
      const segs = Editor.wrap(this.lines[r], cols)
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i]
        const segEnd = i === segs.length - 1 ? this.lines[r].length : segs[i + 1].start
        let text = seg.text
        if (r === this.row && this.col >= seg.start && (this.col < segEnd || i === segs.length - 1)) {
          const at = this.col - seg.start
          text = text.slice(0, at) + cursor + text.slice(at)
          cursorRow = visual.length
        }
        visual.push(text)
      }
    }
    // Scroll the viewport so the cursor row is visible, with a little context.
    if (cursorRow < this.viewTop) this.viewTop = Math.max(0, cursorRow - 1)
    if (cursorRow >= this.viewTop + rows) this.viewTop = cursorRow - rows + 2
    this.viewTop = Math.max(0, Math.min(this.viewTop, Math.max(0, visual.length - rows)))
    const shown = visual.slice(this.viewTop, this.viewTop + rows)
    return { rows: shown, cursorRow: cursorRow - this.viewTop, line: this.row + 1, col: this.col + 1, totalLines: this.lines.length }
  }
}
