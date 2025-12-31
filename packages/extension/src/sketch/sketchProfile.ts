import type { SketchProfile as ApiSketchProfile } from 'ardunno-cli/api'
import { FQBN } from 'fqbn'
import type { SketchFolder } from 'vscode-arduino-api'

import type { SketchFolderState } from './sketchFolder'

/**
 * Minimal, profile-like snapshot of a sketch's tool configuration. Mirrors the
 * core fields of a profiles entry but omits platforms and libraries.
 *
 * This is the shape we persist into the extension host memento for each sketch
 * folder and later reconstruct the sketch state from.
 */
export type SketchProfile = Partial<
  Pick<
    ApiSketchProfile,
    'fqbn' | 'port' | 'protocol' | 'programmer' | 'portConfig'
  >
>

/**
 * Derive a profile-like view from a sketch folder state.
 *
 * This is the single source of truth for how we capture per-sketch tool
 * configuration to persist between sessions.
 */
export function toSketchProfile(
  state:
    | SketchFolderState
    | Readonly<
        Pick<
          SketchFolder,
          'board' | 'port' | 'configOptions' | 'selectedProgrammer'
        >
      >
): SketchProfile {
  const { board, port, configOptions, selectedProgrammer } = state

  // Prefer explicit configOptions FQBN; fall back to the board's FQBN.
  const fqbn = configOptions ?? board?.fqbn

  const protocol = port?.protocol
  const address = (port as any)?.address as string | undefined

  const programmerId =
    typeof selectedProgrammer === 'string'
      ? selectedProgrammer
      : selectedProgrammer?.id

  return {
    fqbn,
    port: address,
    protocol,
    programmer: programmerId,
  }
}

/**
 * Reconstruct the core sketch folder state from a stored SketchProfile.
 *
 * This is used during sketch resolution before the CLI enriches the state with
 * board details and live port information.
 */
export function stateFromSketchProfile(
  sketchPath: string,
  profile: SketchProfile
): Pick<
  SketchFolderState,
  'sketchPath' | 'board' | 'port' | 'configOptions' | 'selectedProgrammer'
> {
  const fqbn = profile.fqbn
  let configOptions: string | undefined
  if (fqbn) {
    try {
      const parsed = new FQBN(fqbn)
      const hasOptions =
        parsed.options && Object.keys(parsed.options).length > 0
      configOptions = hasOptions ? fqbn : undefined
    } catch {}
  }
  return {
    sketchPath,
    board: fqbn
      ? {
          name: fqbn,
          fqbn,
        }
      : undefined,
    port:
      profile.port || profile.protocol
        ? {
            protocol: profile.protocol ?? '',
            // CLI/boards list may refine this address later.
            address: profile.port ?? '',
          }
        : undefined,
    configOptions,
    selectedProgrammer: profile.programmer,
  }
}
