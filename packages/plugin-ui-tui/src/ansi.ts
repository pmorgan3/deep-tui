import type { RichTextLine, RichTextSpan, Theme, TuiKeyEvent, TuiTone } from '@flect/sdk'

const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '')
}

function isWide(codePoint: number): boolean {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f
    || codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1f300 && codePoint <= 0x1faff)
  )
}

export function visibleWidth(value: string): number {
  let width = 0
  for (const character of stripAnsi(value)) {
    const codePoint = character.codePointAt(0) ?? 0
    width += isWide(codePoint) ? 2 : 1
  }
  return width
}

function cropPlain(value: string, width: number): string {
  if (width <= 0) return ''
  let result = ''
  let used = 0
  for (const character of value) {
    const characterWidth = isWide(character.codePointAt(0) ?? 0) ? 2 : 1
    if (used + characterWidth > width) break
    result += character
    used += characterWidth
  }
  return result
}

export function fit(value: string, width: number): string {
  const current = visibleWidth(value)
  if (current <= width) return `${value}${' '.repeat(Math.max(0, width - current))}`
  return cropPlain(stripAnsi(value), width)
}

interface SgrState {
  foreground?: string
  background?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
}

function updateSgrState(sequence: string, state: SgrState): void {
  const match = sequence.match(/^\u001b\[([\d;]*)m$/)
  if (!match) return
  const codes = (match[1] || '0').split(';').map(value => Number(value))
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index] ?? 0
    if (code === 0) {
      delete state.foreground
      delete state.background
      delete state.bold
      delete state.dim
      delete state.italic
      delete state.underline
    } else if (code === 1) state.bold = true
    else if (code === 2) state.dim = true
    else if (code === 3) state.italic = true
    else if (code === 4) state.underline = true
    else if (code === 22) { delete state.bold; delete state.dim }
    else if (code === 23) delete state.italic
    else if (code === 24) delete state.underline
    else if (code === 39) delete state.foreground
    else if (code === 49) delete state.background
    else if ((code === 38 || code === 48) && codes[index + 1] === 2 && codes.length > index + 4) {
      const color = codes.slice(index, index + 5).join(';')
      if (code === 38) state.foreground = color
      else state.background = color
      index += 4
    }
  }
}

function sgrPrefix(state: SgrState): string {
  const codes = [
    state.foreground,
    state.background,
    ...(state.bold ? ['1'] : []),
    ...(state.dim ? ['2'] : []),
    ...(state.italic ? ['3'] : []),
    ...(state.underline ? ['4'] : []),
  ].filter((value): value is string => Boolean(value))
  return codes.length ? `\u001b[${codes.join(';')}m` : ''
}

/** Hard-wrap terminal text without splitting ANSI control sequences or losing
 * active SGR styling at a generated row boundary. */
export function wrapAnsi(value: string, width: number): string[] {
  if (width <= 0) return ['']
  const output: string[] = []
  const state: SgrState = {}
  let line = ''
  let used = 0
  let index = 0
  const push = (continuing: boolean) => {
    const prefix = sgrPrefix(state)
    output.push(`${line}${continuing && prefix ? '\u001b[0m' : ''}`)
    line = continuing ? prefix : ''
    used = 0
  }
  while (index < value.length) {
    const escape = value.slice(index).match(/^\u001b\[[0-?]*[ -/]*[@-~]/)?.[0]
    if (escape) {
      line += escape
      updateSgrState(escape, state)
      index += escape.length
      continue
    }
    const codePoint = value.codePointAt(index)
    const character = codePoint === undefined ? value[index] ?? '' : String.fromCodePoint(codePoint)
    if (!character) break
    if (character === '\r') {
      index += character.length
      continue
    }
    if (character === '\n') {
      push(true)
      index += character.length
      continue
    }
    const characterWidth = isWide(codePoint ?? 0) ? 2 : 1
    if (used > 0 && used + characterWidth > width) push(true)
    line += character
    used += characterWidth
    index += character.length
  }
  output.push(line)
  return output.length ? output : ['']
}

export function wrap(value: string, width: number): string[] {
  if (width <= 0) return ['']
  const paragraphs = value.replace(/\r/g, '').split('\n')
  const output: string[] = []
  for (const paragraph of paragraphs) {
    if (!paragraph) {
      output.push('')
      continue
    }
    let line = ''
    let lineWidth = 0
    for (const word of paragraph.split(/(\s+)/)) {
      if (!word) continue
      const wordWidth = visibleWidth(word)
      if (line && lineWidth + wordWidth > width && !/^\s+$/.test(word)) {
        output.push(line.trimEnd())
        line = ''
        lineWidth = 0
      }
      if (wordWidth > width) {
        for (const character of word) {
          const characterWidth = visibleWidth(character)
          if (lineWidth + characterWidth > width) {
            output.push(line)
            line = ''
            lineWidth = 0
          }
          line += character
          lineWidth += characterWidth
        }
      } else {
        line += word
        lineWidth += wordWidth
      }
    }
    output.push(line.trimEnd())
  }
  return output.length ? output : ['']
}

export function style(theme: Theme, enabled: boolean, text: string, tone: TuiTone = 'foreground', bold = false): string {
  const hex = theme.tokens.colors[tone]
  if (!enabled || !hex || !/^#[\da-f]{6}$/i.test(hex)) return text
  const red = Number.parseInt(hex.slice(1, 3), 16)
  const green = Number.parseInt(hex.slice(3, 5), 16)
  const blue = Number.parseInt(hex.slice(5, 7), 16)
  return `\u001b[${bold ? '1;' : ''}38;2;${red};${green};${blue}m${text}\u001b[${bold ? '22;' : ''}39m`
}

function trueColorCode(value: string | undefined, backgroundColor: boolean): string | undefined {
  if (!value || !/^#[\da-f]{6}$/i.test(value)) return undefined
  const red = Number.parseInt(value.slice(1, 3), 16)
  const green = Number.parseInt(value.slice(3, 5), 16)
  const blue = Number.parseInt(value.slice(5, 7), 16)
  return `${backgroundColor ? 48 : 38};2;${red};${green};${blue}`
}

function styleSpan(span: RichTextSpan, enabled: boolean, baseBackground?: string): string {
  const text = span.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
  const style = span.style
  if (!enabled || !style) return text
  const codes: string[] = []
  const resets: string[] = []
  const color = (value: string | undefined, backgroundColor: boolean) => {
    const code = trueColorCode(value, backgroundColor)
    if (!code) return
    codes.push(code)
    resets.push(backgroundColor ? (trueColorCode(baseBackground, true) ?? '49') : '39')
  }
  color(style.foreground, false)
  color(style.background, true)
  if (style.bold) { codes.push('1'); resets.push('22') }
  if (style.dim) { codes.push('2'); resets.push('22') }
  if (style.italic) { codes.push('3'); resets.push('23') }
  if (style.underline) { codes.push('4'); resets.push('24') }
  return codes.length ? `\u001b[${codes.join(';')}m${text}\u001b[${[...new Set(resets)].join(';')}m` : text
}

export function renderRichText(
  lines: readonly RichTextLine[],
  width: number,
  color: boolean,
  baseBackground?: string,
): string[] {
  const output: RichTextSpan[][] = []
  for (const source of lines) {
    let current: RichTextSpan[] = []
    let used = 0
    const push = () => {
      output.push(current)
      current = []
      used = 0
    }
    for (const span of source.spans) {
      for (const character of span.text.replace(/\r/g, '')) {
        if (character === '\n') {
          push()
          continue
        }
        const characterWidth = visibleWidth(character)
        if (used > 0 && used + characterWidth > width) push()
        const previous = current.at(-1)
        if (previous && JSON.stringify(previous.style) === JSON.stringify(span.style) && previous.link === span.link) {
          previous.text += character
        } else {
          current.push({ text: character, ...(span.style ? { style: span.style } : {}), ...(span.link ? { link: span.link } : {}) })
        }
        used += characterWidth
      }
    }
    push()
  }
  return output.map(line => line.map(span => styleSpan(span, color, baseBackground)).join(''))
}

export function background(theme: Theme, enabled: boolean): string {
  const hex = theme.tokens.colors.background
  if (!enabled || !/^#[\da-f]{6}$/i.test(hex)) return ''
  const red = Number.parseInt(hex.slice(1, 3), 16)
  const green = Number.parseInt(hex.slice(3, 5), 16)
  const blue = Number.parseInt(hex.slice(5, 7), 16)
  return `\u001b[48;2;${red};${green};${blue}m`
}

const ESCAPE_KEYS: Array<[string, string]> = [
  ['\u001b[A', 'up'],
  ['\u001b[B', 'down'],
  ['\u001b[C', 'right'],
  ['\u001b[D', 'left'],
  ['\u001b[H', 'home'],
  ['\u001b[F', 'end'],
  ['\u001b[3~', 'delete'],
  ['\u001b[5~', 'pageup'],
  ['\u001b[6~', 'pagedown'],
  ['\u001b[1~', 'home'],
  ['\u001b[4~', 'end'],
  ['\u001bOH', 'home'],
  ['\u001bOF', 'end'],
  ['\u001b[Z', 'shift+tab'],
]

export function decodeKeys(chunk: string | Uint8Array): TuiKeyEvent[] {
  const source = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
  const events: TuiKeyEvent[] = []
  let index = 0
  while (index < source.length) {
    const remainder = source.slice(index)
    const mouse = remainder.match(/^\u001b\[<(\d+);(\d+);(\d+)([mM])/)
    if (mouse?.[0] && mouse[1] && mouse[2] && mouse[3]) {
      const code = Number(mouse[1])
      const wheelDirection = code & 3
      const x = Number(mouse[2])
      const y = Number(mouse[3])
      if ((code & 64) !== 0 && wheelDirection <= 1) {
        const button = wheelDirection === 0 ? 'wheel-up' : 'wheel-down'
        events.push({
          name: button,
          sequence: mouse[0],
          mouse: { button, x, y },
        })
      } else if (mouse[4] === 'm') {
        events.push({ name: 'mouse-release', sequence: mouse[0], mouse: { button: 'left-release', x, y } })
      } else if ((code & 32) !== 0 && (code & 3) === 3) {
        events.push({ name: 'mouse-move', sequence: mouse[0], mouse: { button: 'move', x, y } })
      } else if ((code & 32) !== 0 && (code & 3) === 0) {
        events.push({ name: 'mouse-drag', sequence: mouse[0], mouse: { button: 'left-drag', x, y } })
      } else if ((code & 3) === 0) {
        events.push({ name: 'mouse-left', sequence: mouse[0], mouse: { button: 'left', x, y } })
      }
      index += mouse[0].length
      continue
    }
    const escape = ESCAPE_KEYS.find(([sequence]) => remainder.startsWith(sequence))
    if (escape) {
      events.push({ name: escape[1], sequence: escape[0] })
      index += escape[0].length
      continue
    }
    const character = source[index]
    if (!character) break
    if (character === '\u001b') {
      events.push({ name: 'escape', sequence: character })
    } else if (character === '\u0003') {
      events.push({ name: 'ctrl+c', sequence: character })
    } else if (character === '\u0002') {
      events.push({ name: 'ctrl+b', sequence: character })
    } else if (character === '\u000c') {
      events.push({ name: 'ctrl+l', sequence: character })
    } else if (character === '\u0010') {
      events.push({ name: 'ctrl+p', sequence: character })
    } else if (character === '\u0014') {
      events.push({ name: 'ctrl+t', sequence: character })
    } else if (character === '\u0015') {
      events.push({ name: 'ctrl+u', sequence: character })
    } else if (character === '\u0004') {
      events.push({ name: 'ctrl+d', sequence: character })
    } else if (character === '\t') {
      events.push({ name: 'tab', sequence: character })
    } else if (character === '\r' || character === '\n') {
      events.push({ name: 'enter', sequence: character })
    } else if (character === '\u007f' || character === '\b') {
      events.push({ name: 'backspace', sequence: character })
    } else if (character >= ' ') {
      const codePoint = source.codePointAt(index)
      const text = codePoint === undefined ? character : String.fromCodePoint(codePoint)
      events.push({ name: 'text', sequence: text, text })
      index += text.length
      continue
    }
    index += 1
  }
  return events
}

function incompleteEscape(value: string): boolean {
  if (!value.startsWith('\u001b')) return false
  if (ESCAPE_KEYS.some(([sequence]) => sequence.startsWith(value) && sequence !== value)) return true
  return /^\u001b(?:\[<?[\d;]*|O)?$/.test(value)
}

/** Stateful terminal decoder that preserves split UTF-8 and escape sequences. */
export class TuiInputDecoder {
  private readonly decoder = new TextDecoder()
  private pending = ''

  push(chunk: string | Uint8Array): TuiKeyEvent[] {
    this.pending += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true })
    const escape = this.pending.lastIndexOf('\u001b')
    if (escape >= 0) {
      const suffix = this.pending.slice(escape)
      if (incompleteEscape(suffix)) {
        const ready = this.pending.slice(0, escape)
        this.pending = suffix
        return decodeKeys(ready)
      }
    }
    const ready = this.pending
    this.pending = ''
    return decodeKeys(ready)
  }

  flush(): TuiKeyEvent[] {
    this.pending += this.decoder.decode()
    const ready = this.pending
    this.pending = ''
    return decodeKeys(ready)
  }
}
