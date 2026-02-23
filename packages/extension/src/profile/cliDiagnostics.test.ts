import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import * as vscode from 'vscode'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { collectCliDiagnostics } from './cliDiagnostics'

describe('profile CLI validation rules', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    vi.restoreAllMocks()
    while (tempDirs.length) {
      const dir = tempDirs.pop()
      if (!dir) {
        continue
      }
      rmSync(dir, { recursive: true, force: true })
    }
  })

  describe('rule: invalid FQBN format', () => {
    it('reports an error', async () => {
      const text = `profiles:
  demo:
    fqbn: invalid
`
      const doc = createTextDocument(text)

      const diagnostics = await collectCliDiagnostics(
        createBoardlabContext(),
        doc,
        text
      )

      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]?.message).toBe('Invalid FQBN format')
      expect(diagnostics[0]?.severity).toBe(vscode.DiagnosticSeverity.Error)
    })
  })

  describe('rule: unknown FQBN board option', () => {
    it('reports an error', async () => {
      const text = `profiles:
  demo:
    fqbn: arduino:avr:uno:speed=fast
`
      const doc = createTextDocument(text)

      const diagnostics = await collectCliDiagnostics(
        createBoardlabContext({
          getBoardDetails: async () => ({
            configOptions: [
              { option: 'cpu', values: [{ value: 'atmega328' }] },
            ],
          }),
        }),
        doc,
        text
      )

      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]?.message).toBe(
        "Unknown board option 'speed' in FQBN"
      )
      expect(diagnostics[0]?.severity).toBe(vscode.DiagnosticSeverity.Error)
    })
  })

  describe('rule: invalid FQBN board option value', () => {
    it('reports an error', async () => {
      const text = `profiles:
  demo:
    fqbn: arduino:avr:uno:cpu=bad-value
`
      const doc = createTextDocument(text)

      const diagnostics = await collectCliDiagnostics(
        createBoardlabContext({
          getBoardDetails: async () => ({
            configOptions: [
              { option: 'cpu', values: [{ value: 'atmega328' }] },
            ],
          }),
        }),
        doc,
        text
      )

      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]?.message).toBe(
        "Invalid value 'bad-value' for board option 'cpu'"
      )
      expect(diagnostics[0]?.severity).toBe(vscode.DiagnosticSeverity.Error)
    })
  })

  describe('rule: board details fetch failure', () => {
    it('surfaces the board-details error message', async () => {
      const text = `profiles:
  demo:
    fqbn: arduino:avr:uno
`
      const doc = createTextDocument(text)

      const diagnostics = await collectCliDiagnostics(
        createBoardlabContext({
          getBoardDetails: async () => {
            throw new Error('board details unavailable')
          },
        }),
        doc,
        text
      )

      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]?.message).toBe('board details unavailable')
      expect(diagnostics[0]?.severity).toBe(vscode.DiagnosticSeverity.Error)
    })
  })

  describe('rule: port setting enumeration failure', () => {
    it('reports a warning', async () => {
      const text = `profiles:
  demo:
    protocol: serial
    port_config:
      baudrate: "9600"
`
      const doc = createTextDocument(text)

      const diagnostics = await collectCliDiagnostics(
        createBoardlabContext({
          getPortSettingsForProtocol: async () => {
            throw new Error('enumeration failed')
          },
        }),
        doc,
        text
      )

      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]?.message).toBe(
        'Unable to enumerate port settings for protocol "serial"'
      )
      expect(diagnostics[0]?.severity).toBe(vscode.DiagnosticSeverity.Warning)
    })
  })

  describe('rule: unavailable port setting', () => {
    it('reports an error', async () => {
      const text = `profiles:
  demo:
    protocol: serial
    port_config:
      stop_bits: "1"
`
      const doc = createTextDocument(text)

      const diagnostics = await collectCliDiagnostics(
        createBoardlabContext({
          getPortSettingsForProtocol: async () => [
            { settingId: 'baudrate', enumValues: ['9600', '115200'] },
          ],
        }),
        doc,
        text
      )

      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]?.message).toBe(
        'Setting "stop_bits" is not available for protocol "serial"'
      )
      expect(diagnostics[0]?.severity).toBe(vscode.DiagnosticSeverity.Error)
    })
  })

  describe('rule: invalid port setting enum value', () => {
    it('reports an error', async () => {
      const text = `profiles:
  demo:
    protocol: serial
    port_config:
      baudrate: "57600"
`
      const doc = createTextDocument(text)

      const diagnostics = await collectCliDiagnostics(
        createBoardlabContext({
          getPortSettingsForProtocol: async () => [
            { settingId: 'baudrate', enumValues: ['9600', '115200'] },
          ],
        }),
        doc,
        text
      )

      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]?.message).toBe(
        'Invalid value "57600" for port setting "baudrate"'
      )
      expect(diagnostics[0]?.severity).toBe(vscode.DiagnosticSeverity.Error)
    })
  })

  describe('rule: missing platform index entry', () => {
    it('reports an error without quick-fix code when no platform_index_url is provided', async () => {
      const text = `profiles:
  demo:
    platforms:
      - example:rl78g23_fpb_p64
`
      const doc = createTextDocument(text)

      const diagnostics = await collectCliDiagnostics(
        createBoardlabContext({
          platformsManager: {
            lookupPlatformQuick: async () => undefined,
          },
        }),
        doc,
        text
      )

      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]?.message).toBe(
        "Platform 'example:rl78g23_fpb_p64' not found in any known index"
      )
      expect(diagnostics[0]?.code).toBeUndefined()
      expect(diagnostics[0]?.severity).toBe(vscode.DiagnosticSeverity.Error)
    })
  })

  describe('rule: missing platform with custom platform_index_url', () => {
    it('reports missingPlatformIndexUrl', async () => {
      const text = `profiles:
  demo:
    platforms:
      - platform: attiny:avr
        platform_index_url: https://example.invalid/package_attiny_index.json
`
      const doc = createTextDocument(text)

      const diagnostics = await collectCliDiagnostics(
        createBoardlabContext({
          platformsManager: {
            lookupPlatformQuick: async () => undefined,
          },
        }),
        doc,
        text
      )

      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]?.message).toContain(
        "Platform 'attiny:avr' not found in any known index; profile declares platform_index_url:"
      )
      expect(diagnostics[0]?.code).toBe('missingPlatformIndexUrl')
      expect(diagnostics[0]?.severity).toBe(vscode.DiagnosticSeverity.Error)
    })
  })

  describe('rule: invalid platform version', () => {
    it('reports invalidPlatformVersion', async () => {
      const text = `profiles:
  demo:
    platforms:
      - test:arch (2.0.0)
`
      const doc = createTextDocument(text)

      const diagnostics = await collectCliDiagnostics(
        createBoardlabContext({
          platformsManager: {
            lookupPlatformQuick: async () => ({
              label: 'Test Platform',
              availableVersions: ['1.0.0'],
              installedVersion: '1.0.0',
            }),
          },
        }),
        doc,
        text
      )

      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]?.message).toBe(
        "Platform 'test:arch' has no release '2.0.0'"
      )
      expect(diagnostics[0]?.code).toBe('invalidPlatformVersion')
      expect(diagnostics[0]?.severity).toBe(vscode.DiagnosticSeverity.Error)
    })
  })

  describe('rule: missing requested platform version (not installed)', () => {
    it('reports missingPlatformVersion as warning', async () => {
      const text = `profiles:
  demo:
    platforms:
      - test:arch (2.0.0)
`
      const doc = createTextDocument(text)

      const diagnostics = await collectCliDiagnostics(
        createBoardlabContext({
          platformsManager: {
            lookupPlatformQuick: async () => ({
              label: 'Test Platform',
              availableVersions: ['2.0.0'],
              installedVersion: undefined,
            }),
          },
        }),
        doc,
        text
      )

      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]?.message).toBe(
        "Platform 'Test Platform' [test:arch] version '2.0.0' is not installed"
      )
      expect(diagnostics[0]?.code).toBe('missingPlatformVersion')
      expect(diagnostics[0]?.severity).toBe(vscode.DiagnosticSeverity.Warning)
    })
  })

  describe('rule: installed platform version mismatch', () => {
    it('reports missingPlatformVersion as warning', async () => {
      const text = `profiles:
  demo:
    platforms:
      - test:arch (2.0.0)
`
      const doc = createTextDocument(text)

      const diagnostics = await collectCliDiagnostics(
        createBoardlabContext({
          platformsManager: {
            lookupPlatformQuick: async () => ({
              label: 'Test Platform',
              availableVersions: ['1.0.0', '2.0.0'],
              installedVersion: '1.0.0',
            }),
          },
        }),
        doc,
        text
      )

      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]?.message).toBe(
        "Platform 'Test Platform' [test:arch] installed '1.0.0' but profile requires '2.0.0'"
      )
      expect(diagnostics[0]?.code).toBe('missingPlatformVersion')
      expect(diagnostics[0]?.severity).toBe(vscode.DiagnosticSeverity.Warning)
    })
  })

  describe('rule: platform missing installation (no version requested)', () => {
    it('reports missingPlatform as warning', async () => {
      const text = `profiles:
  demo:
    platforms:
      - test:arch
`
      const doc = createTextDocument(text)

      const diagnostics = await collectCliDiagnostics(
        createBoardlabContext({
          platformsManager: {
            lookupPlatformQuick: async () => ({
              label: 'Test Platform',
              availableVersions: ['1.0.0'],
              installedVersion: undefined,
            }),
          },
        }),
        doc,
        text
      )

      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]?.message).toBe(
        "Platform 'Test Platform' [test:arch] is not installed"
      )
      expect(diagnostics[0]?.code).toBe('missingPlatform')
      expect(diagnostics[0]?.severity).toBe(vscode.DiagnosticSeverity.Warning)
    })
  })

  describe('rule: invalid platform_index_url scheme', () => {
    it('reports an error', async () => {
      const text = `profiles:
  demo:
    platforms:
      - platform: test:arch
        platform_index_url: ftp://example.invalid/package_index.json
`
      const doc = createTextDocument(text)

      const diagnostics = await collectCliDiagnostics(
        createBoardlabContext({
          platformsManager: {
            lookupPlatformQuick: async () => ({
              label: 'Test Platform',
              availableVersions: ['1.0.0'],
              installedVersion: '1.0.0',
            }),
          },
        }),
        doc,
        text
      )

      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]?.message).toBe(
        'Invalid platform_index_url scheme: ftp://example.invalid/package_index.json'
      )
      expect(diagnostics[0]?.severity).toBe(vscode.DiagnosticSeverity.Error)
    })
  })

  describe('rule: library dir path points to a file', () => {
    it('reports a warning', async () => {
      const workspace = makeTempWorkspace(tempDirs)
      writeFileSync(path.join(workspace, 'not-a-directory.txt'), 'content')

      const text = `profiles:
  demo:
    libraries:
      - dir: ./not-a-directory.txt
`
      const doc = createTextDocument(text, path.join(workspace, 'sketch.yaml'))

      const diagnostics = await collectCliDiagnostics(
        createBoardlabContext(),
        doc,
        text
      )

      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]?.message).toBe(
        'Library dir is not a directory: ./not-a-directory.txt'
      )
      expect(diagnostics[0]?.severity).toBe(vscode.DiagnosticSeverity.Warning)
    })
  })

  describe('rule: library dir path does not exist', () => {
    it('reports a warning', async () => {
      const workspace = makeTempWorkspace(tempDirs)
      const text = `profiles:
  demo:
    libraries:
      - dir: ./missing-library-dir
`
      const doc = createTextDocument(text, path.join(workspace, 'sketch.yaml'))

      const diagnostics = await collectCliDiagnostics(
        createBoardlabContext(),
        doc,
        text
      )

      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]?.message).toBe(
        'Library dir not found: ./missing-library-dir'
      )
      expect(diagnostics[0]?.severity).toBe(vscode.DiagnosticSeverity.Warning)
    })
  })

  describe('rule: invalid library directive format', () => {
    it('reports invalidLibraryDirective', async () => {
      const text = `profiles:
  demo:
    libraries:
      - LiquidCrystal
`
      const doc = createTextDocument(text)

      const diagnostics = await collectCliDiagnostics(
        createBoardlabContext(),
        doc,
        text
      )

      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]?.message).toBe(
        'Invalid library directive: LiquidCrystal'
      )
      expect(diagnostics[0]?.code).toBe('invalidLibraryDirective')
      expect(diagnostics[0]?.severity).toBe(vscode.DiagnosticSeverity.Error)
    })
  })

  describe('rule: missing library metadata entry', () => {
    it('reports an error when the library cannot be found', async () => {
      const text = `profiles:
  demo:
    libraries:
      - MissingLib (1.0.0)
`
      const doc = createTextDocument(text)

      const diagnostics = await collectCliDiagnostics(
        createBoardlabContext({
          librariesManager: {
            lookupLibraryQuick: async () => undefined,
          },
        }),
        doc,
        text
      )

      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]?.message).toBe("Library 'MissingLib' not found")
      expect(diagnostics[0]?.severity).toBe(vscode.DiagnosticSeverity.Error)
    })
  })

  describe('rule: invalid library version', () => {
    it('reports invalidLibraryVersion', async () => {
      const text = `profiles:
  demo:
    libraries:
      - DemoLib (1.0.0)
`
      const doc = createTextDocument(text)

      const diagnostics = await collectCliDiagnostics(
        createBoardlabContext({
          librariesManager: {
            lookupLibraryQuick: async () => ({
              label: 'DemoLib',
              availableVersions: ['2.0.0'],
              installedVersion: '2.0.0',
            }),
          },
        }),
        doc,
        text
      )

      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]?.message).toBe(
        "Library 'DemoLib' has no release '1.0.0'"
      )
      expect(diagnostics[0]?.code).toBe('invalidLibraryVersion')
      expect(diagnostics[0]?.severity).toBe(vscode.DiagnosticSeverity.Error)
    })
  })

  describe('rule: requested library version not installed', () => {
    it('reports missingLibrary as warning', async () => {
      const text = `profiles:
  demo:
    libraries:
      - DemoLib (1.0.0)
`
      const doc = createTextDocument(text)

      const diagnostics = await collectCliDiagnostics(
        createBoardlabContext({
          librariesManager: {
            lookupLibraryQuick: async () => ({
              label: 'DemoLib',
              availableVersions: ['1.0.0'],
              installedVersion: undefined,
            }),
          },
        }),
        doc,
        text
      )

      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]?.message).toBe(
        "Library 'DemoLib' version '1.0.0' is not installed"
      )
      expect(diagnostics[0]?.code).toBe('missingLibrary')
      expect(diagnostics[0]?.severity).toBe(vscode.DiagnosticSeverity.Warning)
    })
  })

  describe('rule: installed library version mismatch', () => {
    it('reports missingLibrary as warning', async () => {
      const text = `profiles:
  demo:
    libraries:
      - DemoLib (1.0.0)
`
      const doc = createTextDocument(text)

      const diagnostics = await collectCliDiagnostics(
        createBoardlabContext({
          librariesManager: {
            lookupLibraryQuick: async () => ({
              label: 'DemoLib',
              availableVersions: ['1.0.0', '2.0.0'],
              installedVersion: '2.0.0',
            }),
          },
        }),
        doc,
        text
      )

      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]?.message).toBe(
        "Library 'DemoLib' installed '2.0.0' but profile requires '1.0.0'"
      )
      expect(diagnostics[0]?.code).toBe('missingLibrary')
      expect(diagnostics[0]?.severity).toBe(vscode.DiagnosticSeverity.Warning)
    })
  })
})

interface MockContext {
  getBoardDetails: (fqbn: unknown) => Promise<{ configOptions: any[] }>
  getPortSettingsForProtocol: (
    protocol: string,
    fqbn?: string
  ) => Promise<Array<{ settingId: string; enumValues?: string[] }>>
  platformsManager: {
    lookupPlatformQuick: (id: string) => Promise<
      | {
          label?: string
          availableVersions: string[]
          installedVersion?: string
        }
      | undefined
    >
  }
  librariesManager: {
    lookupLibraryQuick: (name: string) => Promise<
      | {
          label?: string
          availableVersions: string[]
          installedVersion?: string
        }
      | undefined
    >
  }
}

function createBoardlabContext(overrides: Partial<MockContext> = {}): any {
  const defaults: MockContext = {
    getBoardDetails: async () => ({ configOptions: [] }),
    getPortSettingsForProtocol: async () => [],
    platformsManager: {
      lookupPlatformQuick: async () => undefined,
    },
    librariesManager: {
      lookupLibraryQuick: async () => undefined,
    },
  }
  return {
    ...defaults,
    ...overrides,
    platformsManager: {
      ...defaults.platformsManager,
      ...(overrides.platformsManager ?? {}),
    },
    librariesManager: {
      ...defaults.librariesManager,
      ...(overrides.librariesManager ?? {}),
    },
  }
}

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

function makeTempWorkspace(tempDirs: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'boardlab-profile-rules-'))
  tempDirs.push(dir)
  return dir
}
