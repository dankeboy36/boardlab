// @ts-check

/**
 * Gets the CSP nonce injected by the host (if any).
 *
 * @returns {string | undefined}
 */
export function getCspNonce() {
  if (typeof window === 'undefined') {
    return undefined
  }
  const value = window.__CSP_NONCE__
  return typeof value === 'string' && value.length ? value : undefined
}

/**
 * Applies the CSP nonce to the given DOM element if available.
 *
 * @template {HTMLElement | HTMLLinkElement | HTMLStyleElement} T
 * @param {T} element
 * @returns {T}
 */
export function applyNonce(element) {
  const nonce = getCspNonce()
  if (nonce && element && typeof element.setAttribute === 'function') {
    element.setAttribute('nonce', nonce)
  }
  return element
}

// Note: Any ambient typing for __CSP_NONCE__ should be added via .d.ts in TS projects.
