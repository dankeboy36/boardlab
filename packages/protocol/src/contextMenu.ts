export interface VscodeDataContextParams {
  /**
   * Must be JSON serializable. This is passed as the command args when a menu
   * item executes.
   */
  readonly args?: readonly any[]
  /**
   * Arbitrary section identifier to scope context menu contributions. For
   * example, 'toolbar', 'search-filter', etc., custom per webview.
   */
  readonly webviewSection: string
  /** Additional JSON-serializable properties for `when` expressions. */
  readonly [key: string]: any
}
