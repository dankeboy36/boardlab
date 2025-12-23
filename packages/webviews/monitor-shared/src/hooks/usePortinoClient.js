// @ts-check

import { useContext } from 'react'

import { PortinoClientContext } from '../serial-monitor/contexts/PortinoClientContext.js'

export function usePortinoClient() {
  return useContext(PortinoClientContext)
}
