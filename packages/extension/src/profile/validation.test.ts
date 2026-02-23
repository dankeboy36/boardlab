import * as vscode from 'vscode'
import { describe, expect, it } from 'vitest'

import { validateProfilesYAML } from './validation'

describe('profile AST validation rules', () => {
  describe('rule: mixed platform version styles', () => {
    it('reports clear-platform-versions diagnostic with profile-specific code', () => {
      const text = `profiles:
  demo:
    platforms:
      - arduino:avr
      - arduino:mbed_nano (4.4.1)
`
      const doc = createTextDocument(text)

      const diagnostics = validateProfilesYAML(text, doc)
      const issue = diagnostics.find((d) =>
        String(d.message).includes(
          'All platforms in a profile must either require a specific version or not'
        )
      )

      expect(issue).toBeDefined()
      expect(issue?.severity).toBe(vscode.DiagnosticSeverity.Error)
      expect(issue?.code).toBe('boardlab.profiles.clearPlatformVersions:demo')
      expect(issue?.source).toBe('boardlab')
    })
  })

  describe('rule: YAML syntax errors', () => {
    it('reports parser diagnostics as errors', () => {
      const text = `profiles:
  demo:
    fqbn: [
`
      const doc = createTextDocument(text)

      const diagnostics = validateProfilesYAML(text, doc)
      const parserIssues = diagnostics.filter((d) => !d.code)

      expect(parserIssues.length).toBeGreaterThan(0)
      expect(parserIssues[0]?.severity).toBe(vscode.DiagnosticSeverity.Error)
      expect(parserIssues[0]?.source).toBe('boardlab')
    })
  })
})

function createTextDocument(
  text: string,
  fsPath = '/workspace/sketch.yaml'
): vscode.TextDocument {
  const lineOffsets = computeLineOffsets(text)
  return {
    uri: vscode.Uri.file(fsPath),
    getText: () => text,
    positionAt: (offset: number) => {
      const clampedOffset = clamp(offset, 0, text.length)
      let low = 0
      let high = lineOffsets.length
      while (low < high) {
        const mid = Math.floor((low + high) / 2)
        if (lineOffsets[mid] > clampedOffset) {
          high = mid
        } else {
          low = mid + 1
        }
      }
      const line = Math.max(0, low - 1)
      const character = clampedOffset - lineOffsets[line]
      return new vscode.Position(line, character)
    },
    offsetAt: (position: vscode.Position) => {
      const line = clamp(position.line, 0, lineOffsets.length - 1)
      const lineStart = lineOffsets[line]
      const lineEnd =
        line + 1 < lineOffsets.length ? lineOffsets[line + 1] : text.length
      const character = clamp(
        position.character,
        0,
        Math.max(0, lineEnd - lineStart)
      )
      return lineStart + character
    },
  } as vscode.TextDocument
}

function computeLineOffsets(text: string): number[] {
  const offsets = [0]
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') {
      offsets.push(i + 1)
    }
  }
  return offsets
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
