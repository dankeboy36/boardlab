import type { BuilderResult } from 'ardunno-cli/api'
import type { CompileSummary } from 'vscode-arduino-api'

import { toApiBuildProperties } from './boards'

export function toCompileSummary(result: BuilderResult): CompileSummary {
  const {
    buildPath,
    usedLibraries,
    executableSectionsSize,
    boardPlatform,
    buildPlatform,
    buildProperties,
  } = result
  return {
    buildPath,
    usedLibraries,
    executableSectionsSize,
    boardPlatform,
    buildPlatform,
    buildProperties: toApiBuildProperties(buildProperties),
  }
}
