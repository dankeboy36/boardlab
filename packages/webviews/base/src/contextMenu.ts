import type { MouseEvent as ReactMouseEvent } from 'react'

import type { VscodeDataContextParams } from '@boardlab/protocol'

export const preventDefaultContextMenuItems = {
  preventDefaultContextMenuItems: true,
} as const

export function createVscodeDataContext(
  params: VscodeDataContextParams
): string {
  return JSON.stringify({
    ...preventDefaultContextMenuItems,
    ...params,
  })
}

// Dispatch a native context menu from a left click.
// https://code.visualstudio.com/api/extension-guides/webview#context-menus
export function dispatchContextMenuEvent(
  event: ReactMouseEvent<unknown> | MouseEvent
): void {
  // Try to normalize to a DOM MouseEvent
  const anyEvent = event as any
  if (typeof anyEvent.preventDefault === 'function') {
    try {
      anyEvent.preventDefault()
    } catch {}
  }
  const current: HTMLElement | null = (anyEvent.currentTarget as any) ?? null
  const target: HTMLElement | null = (anyEvent.target as any) ?? null
  const dispatchTarget = current ?? target
  if (!dispatchTarget) {
    if (typeof anyEvent.stopPropagation === 'function') {
      try {
        anyEvent.stopPropagation()
      } catch {}
    }
    return
  }
  dispatchTarget.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      clientX: (anyEvent.clientX as number) ?? 0,
      clientY: (anyEvent.clientY as number) ?? 0,
    })
  )
  if (typeof anyEvent.stopPropagation === 'function') {
    try {
      anyEvent.stopPropagation()
    } catch {}
  }
}
