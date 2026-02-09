import type { MonitorSelectionNotification } from './monitor'

/** API for extension-host interactions that webviews can rely on. */
export interface ExtensionClient {
  /** Listen for selection updates pushed from the extension host. */
  onSelectionChanged(
    listener: (selection: MonitorSelectionNotification) => void
  ): () => void

  /** Ask the extension host for the current selection snapshot. */
  getMonitorSelection(): Promise<MonitorSelectionNotification | undefined>

  /** Optional dispose hook for cleanup. */
  dispose?(): void
}
