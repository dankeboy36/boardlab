import type { PortIdentifier } from 'boards-list'
import * as vscode from 'vscode'

export const MONITOR_URI_SCHEME = 'monitor'

export interface MonitorResourceIdentifier {
  readonly port: PortIdentifier
  readonly query: ReadonlyMap<string, string>
}

export interface MonitorUriComponents {
  readonly port: PortIdentifier
  readonly query?: ReadonlyMap<string, string>
}

export function parseMonitorUri(uri: vscode.Uri): MonitorResourceIdentifier {
  if (uri.scheme !== MONITOR_URI_SCHEME) {
    throw new Error(`Unsupported monitor URI scheme: ${uri.scheme}`)
  }
  if (!uri.authority) {
    throw new Error(`Monitor URI missing protocol authority: ${uri.toString()}`)
  }
  const protocol = decodeURIComponent(uri.authority)
  const rawPath = uri.path.startsWith('/') ? uri.path.slice(1) : uri.path
  if (!rawPath) {
    throw new Error(`Monitor URI missing address segment: ${uri.toString()}`)
  }
  const address = decodeURIComponent(rawPath)
  const query = new Map<string, string>()
  if (uri.query) {
    const params = new URLSearchParams(uri.query)
    for (const [key, value] of params.entries()) {
      query.set(key, value)
    }
  }
  return {
    port: { protocol, address },
    query,
  }
}

export function formatMonitorUri(components: MonitorUriComponents): vscode.Uri {
  const { port, query } = components
  const authority = encodeURIComponent(port.protocol)
  const encodedAddress = encodeURIComponent(port.address)
  let uri = `${MONITOR_URI_SCHEME}://${authority}/${encodedAddress}`
  if (query && query.size) {
    const params = new URLSearchParams()
    for (const [key, value] of query.entries()) {
      params.append(key, value)
    }
    const queryString = params.toString()
    if (queryString) {
      uri += `?${queryString}`
    }
  }
  return vscode.Uri.parse(uri, true)
}

export function getMonitorDisplayName(port: PortIdentifier): string {
  return port.address
}
