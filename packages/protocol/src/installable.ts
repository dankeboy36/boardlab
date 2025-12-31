export type Version = string

export interface Installable {
  readonly installedVersion?: Version
  /**
   * The versions are in descending order. The first one is the most recent
   * version.
   */
  readonly availableVersions: readonly Version[]
}
