// @ts-check

import { createContext } from 'react'

/**
 * @typedef {Object} MonitorClientContextType
 * @property {import('../client.js').MonitorClient | undefined} client
 * @property {'connecting'
 *   | 'connected'
 *   | 'disconnected'
 *   | 'disconnecting'
 *   | 'error'} connectionStatus
 * @property {string} [wsUrl]
 */

export const MonitorClientContext = createContext(
  /** @type {MonitorClientContextType} */ ({
    client: undefined,
    connectionStatus: 'disconnected',
  })
)
