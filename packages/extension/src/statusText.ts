import ellipsize from 'ellipsize'

export type Progress =
  | { spinning: true; message?: string } // indefinite spinner
  | { percent: number; message?: string } // bounded progress

export interface StatusParts {
  icon?: string // e.g. '$(dashboard)'
  board?: string // e.g. 'ESP32-S3-WROOM-1-N8R8'
  port?: string // e.g. 'serial:///dev/tty.usbserial-1410@921600'
  sketch?: string // e.g. 'blink.ino'
  profile?: string // e.g. 'dev'
  progress?: Progress // compile/upload progress (optional)
  maxVisible?: number // global budget excluding codicons (default 80)
}

type TruncPos = 'start' | 'middle' | 'end'

const CODICON_RE = /\$\([^)]+\)/g
const ICON_PLACEHOLDER = '\u0000'

/** Visible length in code points (codicons ignored). */
export function visibleLength(input: string): number {
  const noIcons = input.replace(CODICON_RE, '')
  return Array.from(noIcons).length
}

function tokenize(input: string): Array<{ t: 'icon' | 'text'; v: string }> {
  const out: Array<{ t: 'icon' | 'text'; v: string }> = []
  let i = 0
  while (i < input.length) {
    const m = input.slice(i).match(/^(\$\([^)]+\))/)
    if (m) {
      out.push({ t: 'icon', v: m[1] })
      i += m[1].length
    } else {
      let j = i
      while (j < input.length && !input.slice(j).startsWith('$(')) j++
      out.push({ t: 'text', v: input.slice(i, j) })
      i = j
    }
  }
  return out
}

function nearestSpace(
  s: string,
  idx: number,
  dir: -1 | 1,
  maxSeek = 3
): number {
  for (let d = 0; d <= maxSeek; d++) {
    const k = idx + d * dir
    if (k >= 0 && k < s.length && s[k] === ' ') return k
  }
  return idx
}

/**
 * Truncate ignoring codicons. Counts by Unicode code points. position: 'end' |
 * 'middle' | 'start' preferSpace: bias the break near a space (±3 chars)
 */
export function truncateVisibleAdvanced(
  input: string,
  maxVisible: number,
  {
    position = 'end',
    preferSpace = true,
    ellipsis = '…',
  }: { position?: TruncPos; preferSpace?: boolean; ellipsis?: string } = {}
): string {
  if (maxVisible <= 0) return ellipsis
  if (visibleLength(input) <= maxVisible) return input

  if (position === 'start') {
    const tokens = tokenize(input)
    const tail = takeEnd(tokens, maxVisible - 1, preferSpace)
    return ellipsis + tail
  }

  return ellipsizeWithCodicons(input, maxVisible, {
    position,
    preferSpace,
    ellipsis,
  })
}

function ellipsizeWithCodicons(
  input: string,
  maxVisible: number,
  {
    position,
    preferSpace,
    ellipsis,
  }: { position: TruncPos; preferSpace: boolean; ellipsis: string }
): string {
  const tokens = tokenize(input)
  const icons: string[] = []
  let encoded = ''
  for (const token of tokens) {
    if (token.t === 'icon') {
      icons.push(token.v)
      encoded += ICON_PLACEHOLDER
    } else {
      encoded += token.v
    }
  }

  const adjustedMax = maxVisible + icons.length
  const options: {
    ellipse: string
    truncate?: boolean | 'middle'
    chars?: string[]
  } = {
    ellipse: ellipsis,
  }
  if (preferSpace) {
    options.chars = [' ']
  }
  options.truncate = position === 'middle' ? 'middle' : true

  const truncated = ellipsize(encoded, adjustedMax, options as any)
  if (!icons.length) {
    return truncated
  }
  const parts = truncated.split(ICON_PLACEHOLDER)
  if (parts.length === 1) {
    return truncated
  }
  let out = parts[0]
  let iconIndex = 0
  for (let i = 1; i < parts.length; i++) {
    out += (icons[iconIndex++] ?? '') + parts[i]
  }
  return out
}

function takeEnd(
  tokens: Array<{ t: 'icon' | 'text'; v: string }>,
  n: number,
  preferSpace: boolean
): string {
  let need = n
  let out = ''
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (need <= 0) break
    const tk = tokens[i]
    if (tk.t === 'icon') {
      out = tk.v + out
      continue
    }
    const arr = Array.from(tk.v)
    if (arr.length <= need) {
      out = tk.v + out
      need -= arr.length
    } else {
      let sliceStart = arr.length - need
      if (preferSpace && arr.length > need) {
        const raw = arr.join('')
        sliceStart = nearestSpace(raw, arr.length - need - 1, +1) + 1
        sliceStart = Math.max(0, Math.min(sliceStart, arr.length - 1))
      }
      out = arr.slice(sliceStart).join('') + out
      need = 0
    }
  }
  return out
}

function joinSpaced(parts: string[]): string {
  return parts.filter(Boolean).join(' ')
}

function buildProgress(p?: Progress): string {
  if (!p) return ''
  if ('spinning' in p) {
    return p.message ? '$(sync~spin) ' + p.message : '$(sync~spin)'
  }
  const pct = Math.round(Math.max(0, Math.min(100, p.percent ?? 0)))
  return p.message
    ? `$(sync~spin) ${pct}% ${p.message}`
    : `$(sync~spin) ${pct}%`
}

/**
 * Build the final status bar text with global budget and per-segment
 * truncation. Policy:
 *
 * - Board: middle trunc
 * - Port: end trunc
 * - Sketch group: end trunc
 * - Right-to-left truncation order (sketch group -> port -> board)
 */
export function buildStatusText({
  icon = '$(dashboard)',
  board,
  port,
  sketch,
  profile,
  progress,
  maxVisible = 80,
}: StatusParts): string {
  const profileChunk = profile ? '$(account) ' + profile : ''
  const progressChunk = buildProgress(progress)

  const sketchPieces: string[] = []
  if (sketch) sketchPieces.push(sketch)
  if (profileChunk) sketchPieces.push(profileChunk)

  let sketchGroup = ''
  if (sketchPieces.length > 0 || progressChunk) {
    const inner = joinSpaced([sketchPieces.join(' • '), progressChunk])
    sketchGroup = '(' + inner + ')'
  }

  const segments: string[] = [icon]
  const boardIdx = board ? segments.push(board) - 1 : -1
  const portIdx = port ? segments.push(port) - 1 : -1
  const sketchIdx = sketchGroup ? segments.push(sketchGroup) - 1 : -1

  const totalVisible = () => visibleLength(segments.slice(1).join(' '))

  if (totalVisible() <= maxVisible) {
    return joinSpaced(segments)
  }

  // Truncation floors (visible chars) to preserve readability
  const floors: Record<number, number> = {}
  if (boardIdx > 0) floors[boardIdx] = 10 // board min
  if (portIdx > 0) floors[portIdx] = 12 // port min
  if (sketchIdx > 0) floors[sketchIdx] = 10 // sketch/profile/progress min

  // Truncation order: right to left
  const order = [sketchIdx, portIdx, boardIdx].filter((i) => i > 0)

  const segVisible = (i: number) => visibleLength(segments[i])

  while (totalVisible() > maxVisible) {
    let changed = false
    for (const i of order) {
      const cur = segments[i]
      if (!cur) continue
      const len = segVisible(i)
      const min = floors[i] ?? 6
      if (len <= min) continue

      const target = Math.max(min, len - Math.ceil(len / 6))

      // Policy: middle trunc for board; end trunc for others
      if (i === boardIdx) {
        segments[i] = truncateVisibleAdvanced(cur, target, {
          position: 'middle',
          preferSpace: true,
        })
      } else {
        segments[i] = truncateVisibleAdvanced(cur, target, {
          position: 'end',
          preferSpace: true,
        })
      }

      changed = true
      if (totalVisible() <= maxVisible) break
    }
    if (!changed) {
      // Last resort: hard-trim to floors
      for (const i of order) {
        const cur = segments[i]
        if (!cur) continue
        const min = floors[i] ?? 6
        const pos: TruncPos = i === boardIdx ? 'middle' : 'end'
        segments[i] = truncateVisibleAdvanced(cur, min, {
          position: pos,
          preferSpace: true,
        })
      }
      break
    }
  }

  return joinSpaced(segments)
}
