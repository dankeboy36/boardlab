import type { HostOption } from 'pid-port'

export interface PortToPidParams {
  port: number
  host?: HostOption
}

export async function portToPid(
  params: PortToPidParams
): Promise<number | undefined> {
  const { portToPid } = await import('pid-port')
  return portToPid({
    port: params.port,
    host: params.host,
  })
}
