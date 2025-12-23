import { FQBN } from 'fqbn'
import type { ConfigOption } from 'vscode-arduino-api'

// TODO: move to fqbn
/**
 * Computes the new `configOptions` FQBN that stores only non-default overrides.
 *
 * - Defaults are defined by `defaultConfigOptions` when present, otherwise by
 *   `boardFqbn` + `boardConfigOptions`.
 * - When the selected `value` equals the default, the override is removed.
 * - When it differs, the override is added/updated.
 * - When there are no overrides left, `undefined` is returned.
 *
 * The returned string is either:
 *
 * - `undefined` (no overrides), or
 * - `vendor:arch:board:opt1=val1,...` containing only overrides.
 */
export function computeConfigOverrides(params: {
  boardFqbn: string
  boardConfigOptions: readonly ConfigOption[]
  defaultConfigOptions?: string
  currentConfigOptions?: string
  option: string
  value: string
}): string | undefined {
  const {
    boardFqbn,
    boardConfigOptions,
    defaultConfigOptions,
    currentConfigOptions,
    option,
    value,
  } = params

  const baseFqbnString =
    defaultConfigOptions ??
    (boardConfigOptions.length
      ? new FQBN(boardFqbn).withConfigOptions(...boardConfigOptions).toString()
      : boardFqbn)

  const base = new FQBN(baseFqbnString)
  const defaultOptions = base.options ?? {}
  const defaultValue = defaultOptions[option]

  const currentOverrides =
    currentConfigOptions && new FQBN(currentConfigOptions).options
      ? { ...new FQBN(currentConfigOptions).options }
      : {}

  if (defaultValue !== undefined && value === defaultValue) {
    // Selecting the default value removes the override.
    if (option in currentOverrides) {
      delete currentOverrides[option]
    }
  } else {
    currentOverrides[option] = value
  }

  const overrideKeys = Object.keys(currentOverrides)
  const core = base.toString(true) // vendor:arch:board
  const overridesFqbn =
    overrideKeys.length === 0
      ? undefined
      : `${core}:${overrideKeys
          .map((key) => `${key}=${currentOverrides[key]}`)
          .join(',')}`

  return overridesFqbn
}
