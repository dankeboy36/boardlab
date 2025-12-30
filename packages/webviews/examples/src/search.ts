export type SearchConfig =
  | { mode: 'all' }
  | { mode: 'invalid'; error: string }
  | { mode: 'regex'; regex: RegExp }
  | {
      mode: 'substring' | 'whole'
      tokens: string[]
      caseSensitive: boolean
    }

export type ActiveSearchConfig = Exclude<
  SearchConfig,
  { mode: 'all' } | { mode: 'invalid' }
>

const PATH_SPLIT_REGEX = /[\\/]+/

function stripFileExtensionFromPath(text: string): string {
  const segments = text.split(PATH_SPLIT_REGEX)
  const lastIndex = segments.length - 1
  const lastSegment = segments[lastIndex] ?? ''
  const stripped = stripFileExtension(lastSegment)
  if (stripped === lastSegment) {
    return text
  }
  segments[lastIndex] = stripped
  return segments.join('/')
}

function stripFileExtension(segment: string): string {
  const lastDot = segment.lastIndexOf('.')
  if (lastDot <= 0 || lastDot === segment.length - 1) {
    return segment
  }
  return segment.slice(0, lastDot)
}

export type SearchMatchOptions = {
  stripFileExtension?: boolean
}

export function matchesSearchConfig(
  config: ActiveSearchConfig,
  text: string,
  options: SearchMatchOptions = {}
): boolean {
  const normalizedText = options.stripFileExtension
    ? stripFileExtensionFromPath(text)
    : text
  switch (config.mode) {
    case 'regex':
      return config.regex.test(normalizedText)
    case 'substring': {
      const target = config.caseSensitive
        ? normalizedText
        : normalizedText.toLowerCase()
      return config.tokens.every((token) => target.includes(token))
    }
    case 'whole': {
      const segments = normalizedText.split(/[\\/._\s-]+/).filter(Boolean)
      const normalized = config.caseSensitive
        ? segments
        : segments.map((segment) => segment.toLowerCase())
      return config.tokens.every((token) =>
        normalized.some((segment) => segment === token)
      )
    }
    default:
      return false
  }
}
