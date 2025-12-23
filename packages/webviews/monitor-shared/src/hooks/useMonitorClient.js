// @ts-check

import { useContext } from 'react'

import { MonitorClientContext } from '../serial-monitor/contexts/MonitorClientContext.js'

export function useMonitorClient() {
  return useContext(MonitorClientContext)
}
