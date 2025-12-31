import * as vscode from 'vscode'

import {
  buildBuiltinReadmeUri,
  createBuiltinReadmeRequest,
} from './exampleReadmeFs'

export interface BuiltinReadmeRenderContext {
  readonly title: string
  readonly sketchFolder: vscode.Uri
  readonly tag: string
  readonly examplesRoot?: vscode.Uri
  readonly textFileName?: string
  readonly schematicFileName?: string
  readonly layoutFileName?: string
  readonly source?: string
  readonly exampleId?: string
  readonly exampleRelPath?: string
}

/** Open a read-only virtual README for a built-in Arduino sketch. */
export async function showBuiltinSketchReadmeFromFolderStrict(
  sketchFolder: vscode.Uri,
  opts: {
    tag: string
    examplesRoot?: vscode.Uri
    textFileName?: string
    schematicFileName?: string
    layoutFileName?: string
    titlePrefix?: string
    source?: string
    exampleId?: string
    exampleRelPath?: string
  }
): Promise<void> {
  const sketchName = basename(sketchFolder)
  const title = buildTitle(sketchName, opts.titlePrefix)

  const request = createBuiltinReadmeRequest({
    sketchFolder,
    tag: opts.tag,
    title,
    examplesRoot: opts.examplesRoot,
    textFileName: opts.textFileName,
    schematicFileName: opts.schematicFileName,
    layoutFileName: opts.layoutFileName,
    source: opts.source,
    exampleId: opts.exampleId,
    exampleRelPath: opts.exampleRelPath,
  })

  const uri = buildBuiltinReadmeUri(request)
  await vscode.commands.executeCommand('markdown.showPreview', uri)
}

export async function renderBuiltinSketchReadme(
  context: BuiltinReadmeRenderContext
): Promise<string> {
  const sketchName = basename(context.sketchFolder)
  const textFile = context.textFileName ?? `${sketchName}.txt`
  const schematicFile = context.schematicFileName ?? 'schematic.png'
  const layoutFile = context.layoutFileName ?? 'layout.png'

  const txtUri = vscode.Uri.joinPath(context.sketchFolder, textFile)
  const schematicUri = vscode.Uri.joinPath(context.sketchFolder, schematicFile)
  const layoutUri = vscode.Uri.joinPath(context.sketchFolder, layoutFile)
  const mainSketchUri = vscode.Uri.joinPath(
    context.sketchFolder,
    `${sketchName}.ino`
  )

  const textBuf = await readOrUndefined(txtUri)
  const schematicBuf = await readOrUndefined(schematicUri)
  const layoutBuf = await readOrUndefined(layoutUri)
  const sketchBuf = await readOrUndefined(mainSketchUri)

  let bodyText = toUtf8(textBuf)

  const sketchHeader = sketchBuf
    ? extractSketchHeaderInfo(toUtf8(sketchBuf) ?? '', {
        title: context.title,
        sketchName,
      })
    : undefined

  if (!bodyText?.trim() && !sketchHeader) {
    bodyText = '_No description available._'
  }

  let githubLine = ''
  if (context.examplesRoot) {
    const rel = examplesRelativePath(context.sketchFolder, context.examplesRoot)
    if (rel) {
      const url = `https://github.com/arduino/arduino-examples/tree/${context.tag}/examples/${encodeURI(rel)}`
      githubLine = `> Source: [arduino-examples@${context.tag}](${url})`
    }
  }

  const mdParts: string[] = [
    `# ${context.title}`,
    '',
    '> Arduino built-in example',
  ]

  if (githubLine.trim().length) {
    mdParts.push('', githubLine)
  }

  if (bodyText) {
    mdParts.push('', bodyText)
  }

  if (sketchHeader?.notes?.length) {
    const notesMd = formatNotes(sketchHeader.notes)
    if (notesMd.trim().length) {
      mdParts.push('', notesMd)
    }
  }

  if (sketchHeader?.circuit?.length) {
    mdParts.push(
      '',
      '## Circuit',
      sketchHeader.circuit.map((entry) => `- ${entry}`).join('\n')
    )
  }

  if (sketchHeader?.created) {
    mdParts.push('', `**Created:** ${sketchHeader.created}`)
  }

  if (sketchHeader?.modifiers?.length) {
    mdParts.push(
      '',
      '**Modified By**',
      ...sketchHeader.modifiers.map((name) => `- ${name}`)
    )
  }

  if (sketchHeader?.authors?.length) {
    mdParts.push(
      '',
      '**Contributed By**',
      ...sketchHeader.authors.map((name) => `- ${name}`)
    )
  }

  if (sketchHeader?.references?.length) {
    mdParts.push(
      '',
      '**References**',
      ...sketchHeader.references.map((reference) => `- <${reference}>`)
    )
  }

  if (schematicBuf) {
    mdParts.push('', '## Schematic', embedDataPng(schematicBuf, 'Schematic'))
  }
  if (layoutBuf) {
    mdParts.push('', '## Layout', embedDataPng(layoutBuf, 'Layout'))
  }

  return mdParts.join('\n')
}

/* ---------------- helpers ---------------- */

export function sanitizeForPath(s: string): string {
  return s.replace(/[^\w.-]+/g, '_')
}

function buildTitle(sketchName: string, prefix?: string): string {
  return `${prefix ? `${prefix} ` : ''}${sketchName}`.trim()
}

function basename(uri: vscode.Uri): string {
  const p = uri.path.replace(/\/+$/, '')
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.slice(i + 1) : p
}

function toUtf8(buf?: Uint8Array): string | undefined {
  return buf ? Buffer.from(buf).toString('utf8') : undefined
}

function embedDataPng(bytes: Uint8Array, alt: string): string {
  const b64 = Buffer.from(bytes).toString('base64')
  return `![${alt}](data:image/png;base64,${b64})`
}

interface SketchHeaderInfo {
  circuit: string[]
  created?: string
  authors: string[]
  modifiers: string[]
  references: string[]
  notes: string[]
}

function extractSketchHeaderInfo(
  sketchSource: string,
  meta: { title: string; sketchName: string }
): SketchHeaderInfo | undefined {
  const leading = sketchSource.replace(/^\s*/, '')
  let commentBlock: string | undefined
  if (leading.startsWith('/*')) {
    const matchBlock = leading.match(/^\/\*[\s\S]*?\*\//)
    if (matchBlock) {
      commentBlock = matchBlock[0]
    }
  } else if (leading.startsWith('//')) {
    const matchLines = leading.match(/^(?:\/\/.*(?:\r?\n|$))+/)
    if (matchLines) {
      commentBlock = matchLines[0]
    }
  }

  if (!commentBlock) {
    return undefined
  }

  const lines = sanitizeCommentBlock(commentBlock)
  if (!lines.length) {
    return undefined
  }

  while (
    lines.length &&
    isEquivalentTitle(lines[0], meta.title, meta.sketchName)
  ) {
    lines.shift()
  }

  const used = new Array(lines.length).fill(false)
  const result: SketchHeaderInfo = {
    circuit: [],
    authors: [],
    modifiers: [],
    references: [],
    notes: [],
  }

  const circuitIndex = lines.findIndex((line) => {
    const normalized = line.trim().toLowerCase()
    return (
      normalized.startsWith('the circuit') || normalized.startsWith('circuit')
    )
  })
  if (circuitIndex >= 0) {
    used[circuitIndex] = true
    const heading = lines[circuitIndex]
    const colonIndex = heading.indexOf(':')
    const trailing = colonIndex >= 0 ? heading.slice(colonIndex + 1).trim() : ''
    if (trailing) {
      result.notes.push(trailing)
    }
    for (
      let i = circuitIndex + 1;
      i < lines.length && lines[i].trim().length;
      i += 1
    ) {
      const trimmed = lines[i].trim()
      if (/^[-*•]/.test(trimmed)) {
        const bullet = trimmed.replace(/^[-*•]\s*/, '').trim()
        if (bullet) {
          result.circuit.push(bullet)
        }
        used[i] = true
        continue
      }
      if (/^\d+\./.test(trimmed)) {
        const bullet = trimmed.replace(/^\d+\.\s*/, '').trim()
        if (bullet) {
          result.circuit.push(bullet)
        }
        used[i] = true
        continue
      }
      break
    }
  }

  const createdIndex = lines.findIndex((line) =>
    /^created\b/i.test(line.trim())
  )
  if (createdIndex >= 0) {
    used[createdIndex] = true
    const normalized = lines[createdIndex].replace(/^created\s*/i, '').trim()
    if (normalized) {
      result.created = normalized
    }
  }

  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim()
    if (/^modified\b/i.test(trimmed)) {
      used[i] = true
      continue
    }
    if (/^by\s+/i.test(trimmed)) {
      used[i] = true
      const normalized = trimmed.replace(/^by\s+/i, '').trim()
      if (!normalized) {
        continue
      }
      const previous = lines[i - 1]?.trim()
      if (previous && /^modified\b/i.test(previous)) {
        if (!result.modifiers.includes(normalized)) {
          result.modifiers.push(normalized)
        }
      } else if (!result.authors.includes(normalized)) {
        result.authors.push(normalized)
      }
    }
  }

  lines.forEach((line, index) => {
    const trimmed = line.trim()
    const urls = Array.from(trimmed.matchAll(/https?:\/\/\S+/gi), (m) =>
      sanitizeUrl(m[0])
    )
    if (urls.length) {
      urls.forEach((url) => {
        if (!result.references.includes(url)) {
          result.references.push(url)
        }
      })
      const withoutUrls = trimmed.replace(/https?:\/\/\S+/gi, '').trim()
      if (withoutUrls.length) {
        result.notes.push(withoutUrls)
      }
      used[index] = true
    }
  })

  for (let i = 0; i < lines.length; i += 1) {
    if (used[i]) {
      continue
    }
    const line = lines[i]
    if (!line.trim()) {
      result.notes.push('')
      continue
    }
    result.notes.push(line)
  }

  result.notes = trimEmptyNotes(result.notes)

  if (
    !result.circuit.length &&
    !result.created &&
    !result.authors.length &&
    !result.modifiers.length &&
    !result.references.length &&
    !result.notes.length
  ) {
    return undefined
  }

  return result
}

function sanitizeCommentBlock(block: string): string[] {
  const trimmed = block.trim()
  let rawLines: string[]
  if (trimmed.startsWith('/*')) {
    const withoutDelimiters = trimmed
      .replace(/^\/\*+/, '')
      .replace(/\*+\/$/, '')
    rawLines = withoutDelimiters.split(/\r?\n/)
    rawLines = rawLines.map((line) =>
      line.replace(/^\s*\*?\s?/, '').replace(/\s+$/g, '')
    )
  } else {
    rawLines = trimmed
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*\/\/\s?/, '').replace(/\s+$/g, ''))
  }

  const cleaned = rawLines
  while (cleaned.length && !cleaned[0].trim()) {
    cleaned.shift()
  }
  while (cleaned.length && !cleaned[cleaned.length - 1].trim()) {
    cleaned.pop()
  }
  return cleaned
}

function isEquivalentTitle(
  value: string,
  title: string,
  sketchName: string
): boolean {
  const normalizedValue = normalizeTitle(value)
  if (!normalizedValue) {
    return false
  }
  return (
    normalizedValue === normalizeTitle(title) ||
    normalizedValue === normalizeTitle(sketchName)
  )
}

function normalizeTitle(value: string): string {
  return value.replace(/[^a-z0-9]+/gi, '').toLowerCase()
}

function sanitizeUrl(raw: string): string {
  return raw.replace(/[)*.,;]+$/, '')
}

function trimEmptyNotes(notes: string[]): string[] {
  let start = 0
  let end = notes.length
  while (start < end && !notes[start].trim()) {
    start += 1
  }
  while (end > start && !notes[end - 1].trim()) {
    end -= 1
  }
  return notes.slice(start, end)
}

function formatNotes(lines: readonly string[]): string {
  if (!lines.length) {
    return ''
  }
  const sections: string[] = []
  let paragraph: string[] = []
  let list: string[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      if (paragraph.length) {
        sections.push(paragraph.join(' '))
        paragraph = []
      }
      if (list.length) {
        sections.push(list.join('\n'))
        list = []
      }
      continue
    }
    if (/^[-*•]/.test(trimmed)) {
      if (paragraph.length) {
        sections.push(paragraph.join(' '))
        paragraph = []
      }
      list.push(trimmed.replace(/^[-*•]\s*/, '- '))
      continue
    }
    if (list.length) {
      sections.push(list.join('\n'))
      list = []
    }
    paragraph.push(trimmed)
  }
  if (paragraph.length) {
    sections.push(paragraph.join(' '))
  }
  if (list.length) {
    sections.push(list.join('\n'))
  }

  return sections.join('\n\n')
}

/** Read file, return undefined on ENOENT; rethrow anything else. */
async function readOrUndefined(
  uri: vscode.Uri
): Promise<Uint8Array | undefined> {
  try {
    return await vscode.workspace.fs.readFile(uri)
  } catch (err: any) {
    if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') {
      return undefined
    }
    if (
      typeof err?.code === 'string' &&
      /ENOENT|FileNotFound/i.test(err.code)
    ) {
      return undefined
    }
    if (
      typeof err?.message === 'string' &&
      /ENOENT|FileNotFound/i.test(err.message)
    ) {
      return undefined
    }
    throw err
  }
}

/** Compute examples-relative path string without touching the fs. */
function examplesRelativePath(
  sketchFolder: vscode.Uri,
  examplesRoot: vscode.Uri
): string | undefined {
  const ex = stripSlash(examplesRoot.path)
  const f = stripSlash(sketchFolder.path)
  if (!f.startsWith(ex + '/')) return undefined
  return f.slice(ex.length + 1)
}

function stripSlash(p: string) {
  return p.replace(/\/+$/, '')
}
