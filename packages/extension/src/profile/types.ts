/**
 * Representation of a [sketch project
 * file](https://arduino.github.io/arduino-cli/latest/sketch-project-file/)
 * (`sketch.yaml`).
 */
export interface Profiles extends ProfilesDefaults {
  readonly profiles?: Readonly<Record<string, Partial<Profile>>>
}

/**
 * [Default flags for Arduino CLI
 * usage](https://arduino.github.io/arduino-cli/latest/sketch-project-file/#default-flags-for-arduino-cli-usage).
 */
export interface ProfilesDefaults {
  readonly default_fqbn?: string
  /** Equivalent of `PortIdentifier.protocol`. For example, `"serial"`. */
  readonly default_protocol?: string
  /** Equivalent of `PortIdentifier.address`. For example, `"/dev/ttyACM0"`. */
  readonly default_port?: string
  readonly default_profile?: string
}

export interface Profile {
  readonly notes?: string
  readonly fqbn: string
  readonly platforms?: readonly ProfilePlatform[]
  readonly libraries?: readonly ProfileLibrary[]
}

export interface ProfilePlatform {
  readonly platform: string
  readonly platform_index_url?: string
}

export interface ProfileLibrary {
  readonly library: string
}
