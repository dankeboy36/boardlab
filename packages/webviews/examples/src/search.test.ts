import { describe, expect, it } from 'vitest'

import { matchesSearchConfig } from './search'

describe('matchesSearchConfig', () => {
  const resourcePath = 'LibraryFoo/SketchBar/SketchBar.ino'

  it('ignores file extensions for substring matching', () => {
    expect(
      matchesSearchConfig(
        { mode: 'substring', tokens: ['ino'], caseSensitive: false },
        resourcePath,
        { stripFileExtension: true }
      )
    ).toBe(false)

    expect(
      matchesSearchConfig(
        { mode: 'substring', tokens: ['sketchbar'], caseSensitive: false },
        resourcePath,
        { stripFileExtension: true }
      )
    ).toBe(true)
  })

  it('ignores file extensions for whole-word matching', () => {
    expect(
      matchesSearchConfig(
        { mode: 'whole', tokens: ['ino'], caseSensitive: false },
        resourcePath,
        { stripFileExtension: true }
      )
    ).toBe(false)

    expect(
      matchesSearchConfig(
        { mode: 'whole', tokens: ['sketchbar'], caseSensitive: false },
        resourcePath,
        { stripFileExtension: true }
      )
    ).toBe(true)
  })
})
