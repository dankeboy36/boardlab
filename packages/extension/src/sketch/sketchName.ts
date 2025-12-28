import filenameReservedRegex, {
  windowsReservedNameRegex,
} from 'filename-reserved-regex'

export const defaultSketchFolderName = 'sketch'
export const defaultFallbackChar = '_'

const timestampSuffixLength = 20

export function reservedFilename(name: string): string {
  return `'${name}' is a reserved filename.`
}

export const noTrailingPeriod = 'A filename cannot end with a dot'
export const invalidSketchFolderNameMessage =
  'The name must start with a letter, number, or underscore, followed by letters, numbers, dashes, dots and underscores. Maximum length is 63 characters.'

/**
 * `undefined` if the candidate sketch folder name is valid. Otherwise, the
 * validation error message.
 *
 * Based on the specs:
 * https://arduino.github.io/arduino-cli/latest/sketch-specification/#sketch-folders-and-files
 */
export function validateSketchFolderName(
  candidate: string
): string | undefined {
  const validFilenameError = isValidFilename(candidate)
  if (validFilenameError) {
    return validFilenameError
  }
  return /^[0-9a-zA-Z_]{1}[0-9a-zA-Z_.-]{0,62}$/.test(candidate)
    ? undefined
    : invalidSketchFolderNameMessage
}

/**
 * Transforms the `candidate` argument into a valid sketch folder name by
 * replacing all invalid characters with underscore (`_`) and trimming the
 * string after 63 characters. If the argument is falsy, returns `"sketch"`.
 */
export function toValidSketchFolderName(
  candidate: string,
  /** Type of `Date` is only for tests. Use boolean for production. */
  appendTimestampSuffix: boolean | Date = false
): string {
  if (!appendTimestampSuffix && windowsReservedNameRegex().test(candidate)) {
    return defaultSketchFolderName
  }
  const validName = candidate
    ? candidate.replace(/[^0-9a-zA-Z_]/g, defaultFallbackChar).slice(0, 63)
    : defaultSketchFolderName
  if (appendTimestampSuffix) {
    return `${validName.slice(0, 63 - timestampSuffixLength)}${
      typeof appendTimestampSuffix === 'boolean'
        ? timestampSuffix()
        : timestampSuffix(appendTimestampSuffix)
    }`
  }
  return validName
}

export function timestampSuffix(date: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const year = date.getUTCFullYear()
  const month = pad(date.getUTCMonth() + 1)
  const day = pad(date.getUTCDate())
  const hours = pad(date.getUTCHours())
  const minutes = pad(date.getUTCMinutes())
  const seconds = pad(date.getUTCSeconds())
  return `_${year}${month}${day}${hours}${minutes}${seconds}`
}

function isValidFilename(candidate: string): string | undefined {
  if (endsWithPeriod(candidate)) {
    return noTrailingPeriod
  }
  if (endsWithSpace(candidate) || isReservedFilename(candidate)) {
    return reservedFilename(candidate)
  }
  return undefined
}

function endsWithPeriod(candidate: string): boolean {
  return candidate.length > 1 && candidate[candidate.length - 1] === '.'
}

function endsWithSpace(candidate: string): boolean {
  return candidate.length > 1 && candidate[candidate.length - 1] === ' '
}

function isReservedFilename(candidate: string): boolean {
  const invalidChars = filenameReservedRegex()
  return (
    invalidChars.test(candidate) || windowsReservedNameRegex().test(candidate)
  )
}
