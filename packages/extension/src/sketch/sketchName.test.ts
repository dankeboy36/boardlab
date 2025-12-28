import { describe, expect, it } from 'vitest'

import {
  defaultFallbackChar,
  defaultSketchFolderName,
  timestampSuffix,
  toValidSketchFolderName,
  validateSketchFolderName,
} from './sketchName'

const windowsReservedFileNames = [
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
] as const
const windowsInvalidFilenames = ['trailingPeriod.', 'trailingSpace '] as const
const invalidFilenames = [
  ...windowsInvalidFilenames,
  ...windowsReservedFileNames,
].map((name) => [name, false] as [string, boolean])

describe('validateSketchFolderName', () => {
  const cases = [
    ...invalidFilenames,
    ['com1', false],
    ['sketch', true],
    ['can-contain-slash-and-dot.ino', true],
    ['regex++', false],
    ['trailing.dots...', false],
    ['no.trailing.dots.._', true],
    ['No Spaces', false],
    ['_validToStartWithUnderscore', true],
    ['Invalid+Char.ino', false],
    ['', false],
    ['/', false],
    ['//trash/', false],
    ['63Length_012345678901234567890123456789012345678901234567890123', true],
    ['TooLong__0123456789012345678901234567890123456789012345678901234', false],
  ] as const

  cases.forEach(([input, expected]) => {
    it(`'${input}' should ${expected ? '' : 'not '}be valid`, () => {
      const actual = validateSketchFolderName(input)
      if (expected) {
        expect(actual).toBeUndefined()
      } else {
        expect(actual).toBeDefined()
        expect(actual?.length).toBeGreaterThan(0)
      }
    })
  })
})

describe('toValidSketchFolderName', () => {
  const cases = [
    ['', defaultSketchFolderName],
    [' ', defaultFallbackChar],
    ['  ', defaultFallbackChar + defaultFallbackChar],
    [
      '0123456789012345678901234567890123456789012345678901234567890123',
      '012345678901234567890123456789012345678901234567890123456789012',
    ],
    ['foo bar', 'foo_bar'],
    ['-foobar', '_foobar'],
    ['vAlid', 'vAlid'],
    ['COM1', defaultSketchFolderName],
    ['COM1.', 'COM1_'],
    ['period.', 'period_'],
  ]

  cases.forEach(([input, expected]) =>
    toMapIt(input, expected, toValidSketchFolderName)
  )
})

describe('toValidSketchFolderName with timestamp suffix', () => {
  const epoch = new Date(0)
  const epochSuffix = timestampSuffix(epoch)
  const cases = [
    ['', defaultSketchFolderName + epochSuffix],
    [' ', defaultFallbackChar + epochSuffix],
    ['  ', defaultFallbackChar + defaultFallbackChar + epochSuffix],
    [
      '0123456789012345678901234567890123456789012345678901234567890123',
      '0123456789012345678901234567890123456789012' + epochSuffix,
    ],
    ['foo bar', 'foo_bar' + epochSuffix],
    ['.foobar', '_foobar' + epochSuffix],
    ['-fooBar', '_fooBar' + epochSuffix],
    ['foobar.', 'foobar_' + epochSuffix],
    ['fooBar-', 'fooBar_' + epochSuffix],
    ['fooBar+', 'fooBar_' + epochSuffix],
    ['vAlid', 'vAlid' + epochSuffix],
    ['COM1', 'COM1' + epochSuffix],
    ['COM1.', 'COM1_' + epochSuffix],
    ['period.', 'period_' + epochSuffix],
  ]

  cases.forEach(([input, expected]) =>
    toMapIt(input, expected, (value: string) =>
      toValidSketchFolderName(value, epoch)
    )
  )
})

function toMapIt(
  input: string,
  expected: string,
  testMe: (input: string) => string
) {
  return it(`should map '${input}' to '${expected}'`, () => {
    const actual = testMe(input)
    expect(actual).toBe(expected)
    const errorMessage = validateSketchFolderName(actual)
    expect(errorMessage).toBeUndefined()
  })
}
