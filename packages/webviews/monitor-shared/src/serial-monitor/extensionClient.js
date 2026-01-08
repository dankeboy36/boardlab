// @ts-check

import { HOST_EXTENSION } from 'vscode-messenger-common'

import { vscode } from '@boardlab/base'
import {
  getMonitorSelection,
  notifyMonitorSelectionChanged,
} from '@boardlab/protocol'

/**
 * @typedef {import('@boardlab/protocol').MonitorSelectionNotification} MonitorSelectionNotification
 *
 *
 * @typedef {import('@boardlab/protocol').ExtensionClient} ExtensionClient
 */

/**
 * Creates a messenger-backed extension client for monitor webviews.
 *
 * @param {{
 *   messenger?: typeof vscode.messenger
 *   host?: import('vscode-messenger-common').MessageParticipant
 * }} [options]
 * @returns {ExtensionClient | undefined}
 */
export function createExtensionClient({
  messenger = vscode.messenger,
  host = HOST_EXTENSION,
} = {}) {
  if (!messenger) {
    return undefined
  }

  /** @type {Set<(selection: MonitorSelectionNotification) => void>} */
  const listeners = new Set()
  const notifyListeners = (
    /** @type {import('@boardlab/protocol').MonitorSelectionNotification} */ selection
  ) => {
    for (const listener of Array.from(listeners)) {
      try {
        listener(selection)
      } catch (error) {
        console.error('Monitor selection listener failed', error)
      }
    }
  }

  const disposable = messenger.onNotification(
    notifyMonitorSelectionChanged,
    notifyListeners
  )

  return {
    dispose() {
      try {
        disposable?.dispose?.()
      } catch (error) {
        console.error('Failed to dispose monitor selection notifier', error)
      }
    },
    onSelectionChanged(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async getMonitorSelection() {
      try {
        return await messenger.sendRequest(getMonitorSelection, host)
      } catch (error) {
        console.error('Failed to resolve monitor selection', error)
        return undefined
      }
    },
  }
}
