// @ts-check

import { createContext } from 'react'

/**
 * @typedef {Object} PortinoClientContextType
 * @property {import('../client.js').PortinoClient | undefined} client
 * @property {'connecting'
 *   | 'connected'
 *   | 'disconnected'
 *   | 'disconnecting'
 *   | 'error'} connectionStatus
 * @property {string} [wsUrl]
 * @property {string} [httpBaseUrl]
 */

export const PortinoClientContext = createContext(
  /** @type {PortinoClientContextType} */ ({
    client: undefined,
    connectionStatus: 'disconnected',
  })
)
