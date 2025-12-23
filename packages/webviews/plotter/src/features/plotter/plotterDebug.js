// @ts-check

/** Lightweight plotter debug logger. Enable with `?plotterdebug=1` in URL. */
export const plotterDebug = (() => {
  const enabled =
    typeof window !== 'undefined' &&
    /(?:^|[?&])plotterdebug=1(?:&|$)/i.test(window.location?.search || '')

  /** @type {any[]} */
  const store = []

  /** @param {string} type @param {Record<string, any>} [data] */
  function log(type, data) {
    if (!enabled) return
    try {
      const t =
        typeof performance !== 'undefined' && performance.now
          ? performance.now()
          : Date.now()
      const entry = Object.assign({ t, type }, data || {})
      store.push(entry)
      // Keep console noise minimal by grouping

      console.debug('[plotter]', entry)
    } catch {}
  }

  function get() {
    return store.slice()
  }

  function clear() {
    store.length = 0
  }

  function download(filename = 'plotter-log.json') {
    try {
      const blob = new Blob([JSON.stringify(store, null, 2)], {
        type: 'application/json',
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch {}
  }

  if (enabled && typeof window !== 'undefined') {
    // Expose helpers for easy access from DevTools
    // @ts-ignore
    window.__plotterLog = { get, clear, download }
  }

  return { enabled, log, get, clear, download }
})()
