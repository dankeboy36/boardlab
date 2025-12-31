// @ts-check
// @ts-ignore vite will load the file as URL
import codiconCssUrl from '@vscode/codicons/dist/codicon.css?url'
import { useInsertionEffect } from 'react'

import { applyNonce } from '../utils/csp.js'

const STYLESHEET_ID = 'vscode-codicon-stylesheet'

/**
 * Ensures the VS Code Codicons stylesheet is present in `document.head` with
 * the expected id so `vscode-icon` components can adopt it in shadow DOM.
 *
 * Uses `useInsertionEffect` to run before DOM mutations, guaranteeing the link
 * exists before custom elements connect.
 */
export function ensureCodiconStylesheet() {
  if (typeof document === 'undefined') return codiconCssUrl
  if (document.getElementById(STYLESHEET_ID)) return codiconCssUrl
  const link = document.createElement('link')
  applyNonce(link)
  link.rel = 'stylesheet'
  link.href = codiconCssUrl
  link.id = STYLESHEET_ID
  document.head.appendChild(link)
  return codiconCssUrl
}

// Eagerly ensure the stylesheet on module load for earliest availability.
if (typeof document !== 'undefined') {
  try {
    ensureCodiconStylesheet()
  } catch {}
}

export function useCodiconStylesheet() {
  // Secondary guarantee for cases where module import order changes
  useInsertionEffect(() => {
    ensureCodiconStylesheet()
  }, [])

  return codiconCssUrl
}
