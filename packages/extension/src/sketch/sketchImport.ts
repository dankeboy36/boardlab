import { promises as fs } from 'node:fs'
import * as path from 'node:path'

export async function copySketchFolder(
  sourceFolder: string,
  destinationFolder: string
): Promise<void> {
  await fs.mkdir(destinationFolder, { recursive: true })
  const entries = await fs.readdir(sourceFolder, { withFileTypes: true })
  for (const entry of entries) {
    const sourcePath = path.join(sourceFolder, entry.name)
    const destinationPath = path.join(destinationFolder, entry.name)
    if (entry.isDirectory()) {
      await copySketchFolder(sourcePath, destinationPath)
    } else if (entry.isSymbolicLink()) {
      const target = await fs.readlink(sourcePath)
      await fs.symlink(target, destinationPath)
    } else {
      await fs.copyFile(sourcePath, destinationPath)
    }
  }
}

export async function renameMainSketchFile(
  destinationFolder: string,
  originalName: string,
  targetName: string,
  preferredExtension?: string
): Promise<string | undefined> {
  const extensions = ['.ino']

  for (const ext of extensions) {
    const originalPath = path.join(destinationFolder, `${originalName}${ext}`)
    if (!(await pathExists(originalPath))) {
      continue
    }
    const targetPath = path.join(destinationFolder, `${targetName}${ext}`)
    if (originalPath !== targetPath) {
      await fs.rename(originalPath, targetPath)
    }
    return targetPath
  }
  return undefined
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.stat(targetPath)
    return true
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return false
    }
    throw error
  }
}
