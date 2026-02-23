import { describe, expect, it } from 'vitest'

import { isMissingProfilesFileError } from './profileValidationTask'

describe('isMissingProfilesFileError', () => {
  it('returns true for fs.access ENOENT errors', () => {
    const error = new Error(
      "ENOENT: no such file or directory, access '/tmp/sketch.yaml'"
    ) as Error & { code: string }
    error.code = 'ENOENT'

    expect(isMissingProfilesFileError(error)).toBe(true)
  })

  it('returns true for VS Code CodeExpectedError missing-file shape', () => {
    const error = new Error(
      "cannot open file:///tmp/sketch.yaml. Detail: Unable to resolve nonexistent file '/tmp/sketch.yaml'"
    )
    error.name = 'CodeExpectedError'
    error.stack =
      "CodeExpectedError: cannot open file:///tmp/sketch.yaml. Detail: Unable to read file '/tmp/sketch.yaml' (Error: Unable to resolve nonexistent file '/tmp/sketch.yaml')"

    expect(isMissingProfilesFileError(error)).toBe(true)
  })

  it('returns false for non-missing-file errors', () => {
    const accessError = new Error('Permission denied') as Error & {
      code: string
    }
    accessError.code = 'EACCES'
    expect(isMissingProfilesFileError(accessError)).toBe(false)
    expect(isMissingProfilesFileError(new Error('Permission denied'))).toBe(
      false
    )
  })
})
