import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { renameMainSketchFile } from './sketchImport'

async function createTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'boardlab-sketch-import-'))
}

describe('renameMainSketchFile', () => {
  it('renames the main ino file when the folder name changes', async () => {
    const tempDir = await createTempDir()
    const original = path.join(tempDir, 'OldName.ino')
    await fs.writeFile(original, 'void setup() {}\n')

    const renamed = await renameMainSketchFile(tempDir, 'OldName', 'NewName')

    expect(renamed).toBe(path.join(tempDir, 'NewName.ino'))
    await expect(
      fs.stat(path.join(tempDir, 'NewName.ino'))
    ).resolves.toBeDefined()
    await expect(fs.stat(path.join(tempDir, 'OldName.ino'))).rejects.toThrow()
  })

  it('returns the current path when the names are unchanged', async () => {
    const tempDir = await createTempDir()
    const original = path.join(tempDir, 'KeepName.ino')
    await fs.writeFile(original, 'void setup() {}\n')

    const renamed = await renameMainSketchFile(tempDir, 'KeepName', 'KeepName')

    expect(renamed).toBe(path.join(tempDir, 'KeepName.ino'))
    await expect(
      fs.stat(path.join(tempDir, 'KeepName.ino'))
    ).resolves.toBeDefined()
  })
})
