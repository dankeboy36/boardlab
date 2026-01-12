import { vscode } from '@boardlab/base'
import { NotifyTraceEvent } from '@boardlab/protocol'

function getWebviewMeta() {
  if (typeof window === 'undefined') {
    return {}
  }
  const { __BOARDLAB_WEBVIEW_ID__, __BOARDLAB_WEBVIEW_TYPE__ } =
    /** @type {Window & { __BOARDLAB_WEBVIEW_ID__?: string; __BOARDLAB_WEBVIEW_TYPE__?: string }} */
    (window)
  return {
    webviewId: __BOARDLAB_WEBVIEW_ID__,
    webviewType: __BOARDLAB_WEBVIEW_TYPE__,
  }
}

/**
 * @param {string} event
 * @param {Record<string, unknown>} [data]
 * @param {Partial<import('@boardlab/protocol').TraceEventNotification>} [overrides]
 */
export function emitWebviewTraceEvent(event, data = {}, overrides = {}) {
  const messenger = vscode.messenger
  if (!messenger) {
    return
  }
  const meta = getWebviewMeta()
  try {
    messenger.sendNotification(NotifyTraceEvent, {
      event,
      data,
      src: { layer: 'webview' },
      ...meta,
      ...overrides,
    })
  } catch (error) {
    console.error('Trace event notify failed', error)
  }
}
