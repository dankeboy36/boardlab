import type { IWebSocket } from 'vscode-ws-jsonrpc'
import WebSocket from 'ws'

export function createNodeSocketAdapter(socket: WebSocket): IWebSocket {
  return {
    send: (content: string) => socket.send(content),
    onMessage: (cb) => {
      socket.on('message', (data) => cb(data))
    },
    onError: (cb) => {
      socket.on('error', (err) => cb(err))
    },
    onClose: (cb) => {
      socket.on('close', (code, reasonBuffer) => {
        let reason = ''
        if (typeof reasonBuffer === 'string') {
          reason = reasonBuffer
        } else if (reasonBuffer instanceof Buffer) {
          reason = reasonBuffer.toString('utf8')
        }
        cb(code ?? 0, reason)
      })
    },
    dispose: () => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.close()
      }
    },
  }
}
