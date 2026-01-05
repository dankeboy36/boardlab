// @ts-check

import './xterm-vscode.css'

const FIND_MATCH_ALPHA = 0.45
const DEFAULT_FIND_MATCH_RGB = [81, 92, 106]
export const DEFAULT_FIND_MATCH_BACKGROUND = `rgba(${DEFAULT_FIND_MATCH_RGB.join(
  ', '
)}, ${FIND_MATCH_ALPHA})`

const hexColorRegex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i
const hexWithAlphaRegex = /^#([0-9a-f]{4}|[0-9a-f]{8})$/i
const rgbRegex = /^rgb\(\s*([0-9]+)[\s,]+([0-9]+)[\s,]+([0-9]+)\s*\)$/i
const slashAlphaRegex = /\/\s*[\d.]+\s*\)$/ // rgb(255 255 255 / 0.5)

const hasExplicitAlpha = (/** @type {string} */ value) =>
  /rgba|hsla/i.test(value) ||
  hexWithAlphaRegex.test(value) ||
  slashAlphaRegex.test(value) ||
  value.trim().toLowerCase() === 'transparent'

const hexToRgb = (/** @type {string} */ value) => {
  let hex = value.replace('#', '')
  if (hex.length === 3) {
    hex = hex
      .split('')
      .map((c) => c + c)
      .join('')
  }
  if (hex.length !== 6) return undefined
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return undefined
  return [r, g, b]
}

/** @param {string | null} value */
export function normalizeAlpha(value, alpha = FIND_MATCH_ALPHA) {
  const color = value?.trim()
  if (!color) return ''
  if (hasExplicitAlpha(color)) return color
  if (hexColorRegex.test(color)) {
    const rgb = hexToRgb(color)
    return rgb ? `rgba(${rgb.join(', ')}, ${alpha})` : color
  }
  const rgbMatch = color.match(rgbRegex)
  if (rgbMatch) {
    const [, r, g, b] = rgbMatch
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }
  return color
}

// Build xterm theme from CSS vars with VS Code-like fallbacks.
function buildXtermThemeFromCSS({ area = detectArea() } = {}) {
  const cs = getComputedStyle(document.documentElement)

  // Helpers
  const v = (/** @type {string} */ name) =>
    cs.getPropertyValue(name).trim() || ''
  const first = (/** @type {(string | undefined)[]} */ ...vals) =>
    vals.find(Boolean)

  // Tokens from VS Code themes (converted to CSS vars by your theming layer):
  const termBg = v('--vscode-terminal-background')
  const termFg = v('--vscode-terminal-foreground')
  const selBg = v('--vscode-terminal-selectionBackground')
  const selInactiveBg = v('--vscode-terminal-inactiveSelectionBackground')
  const curFg = v('--vscode-terminalCursor-foreground')
  const curBg = v('--vscode-terminalCursor-background')

  // Area fallbacks (VS Code logic: terminal.background → editor/sideBar/panel bg)
  const areaBg =
    area === 'editor'
      ? v('--vscode-editor-background')
      : area === 'panel'
        ? v('--vscode-panel-background')
        : v('--vscode-sideBar-background')
  const areaFg =
    area === 'editor'
      ? v('--vscode-editor-foreground')
      : area === 'panel'
        ? v('--vscode-panel-foreground')
        : v('--vscode-sideBar-foreground')

  // ANSI palette (use terminal.ansi* tokens if present; fall back to editor colors reasonably)
  const ansi = (
    /** @type {string} */ name,
    /** @type {string | undefined} */ fallback
  ) => first(v(`--vscode-terminal-ansi${name}`), fallback)
  const gentle = (/** @type {string} */ tok, /** @type {string} */ def) =>
    first(v(tok), def) // helper for bright fallbacks

  /** @type {import('@xterm/xterm').ITerminalOptions['theme']} */
  const theme = {
    background: first(termBg, areaBg, '#1e1e1e'),
    foreground: first(termFg, areaFg, '#cccccc'),
    selectionBackground: first(selBg, 'rgba(0, 122, 204, 0.25)'),
    selectionInactiveBackground: first(
      selInactiveBg,
      'rgba(0, 122, 204, 0.15)'
    ),
    cursor: first(curFg, curBg, areaFg, '#ffffff'),
    cursorAccent: first(curBg, '#000000'),

    // standard ANSI 0-7
    black: ansi('Black', '#000000'),
    red: ansi('Red', '#cd3131'),
    green: ansi('Green', '#0dbc79'),
    yellow: ansi('Yellow', '#e5e510'),
    blue: ansi('Blue', '#2472c8'),
    magenta: ansi('Magenta', '#bc3fbc'),
    cyan: ansi('Cyan', '#11a8cd'),
    white: ansi('White', '#e5e5e5'),

    // bright ANSI 8-15
    brightBlack: ansi(
      'BrightBlack',
      gentle('--vscode-terminal-ansiBlack', '#666666')
    ),
    brightRed: ansi(
      'BrightRed',
      gentle('--vscode-terminal-ansiRed', '#f14c4c')
    ),
    brightGreen: ansi(
      'BrightGreen',
      gentle('--vscode-terminal-ansiGreen', '#23d18b')
    ),
    brightYellow: ansi(
      'BrightYellow',
      gentle('--vscode-terminal-ansiYellow', '#f5f543')
    ),
    brightBlue: ansi(
      'BrightBlue',
      gentle('--vscode-terminal-ansiBlue', '#3b8eea')
    ),
    brightMagenta: ansi(
      'BrightMagenta',
      gentle('--vscode-terminal-ansiMagenta', '#d670d6')
    ),
    brightCyan: ansi(
      'BrightCyan',
      gentle('--vscode-terminal-ansiCyan', '#29b8db')
    ),
    brightWhite: ansi(
      'BrightWhite',
      gentle('--vscode-terminal-ansiWhite', '#ffffff')
    ),
  }

  return theme
}

export function detectArea() {
  const root = document.documentElement
  if (root.classList.contains('vscode-area-panel')) return 'panel'
  if (root.classList.contains('vscode-area-sideBar')) return 'sideBar'
  return 'editor'
}

// Apply to an xterm instance and re-apply on theme change
/**
 * @param {import('@xterm/xterm').Terminal} terminal
 * @param {{ area?: string }} [options]
 */
export function attachXtermTheme(terminal, options = {}) {
  const { area } = options
  const apply = () => {
    const theme = { ...buildXtermThemeFromCSS({ area }) }
    // Apply via the option setter so the renderer updates without resetting
    terminal.options.theme = theme

    if (typeof document !== 'undefined') {
      const root = document.documentElement
      if (root) {
        const ensureToken = (
          /** @type {string} */ name,
          /** @type {string | null} */ fallback,
          { enforceAlpha = false } = {}
        ) => {
          try {
            const current = getComputedStyle(root).getPropertyValue(name).trim()
            if (!current) {
              root.style.setProperty(
                name,
                enforceAlpha ? normalizeAlpha(fallback) || fallback : fallback
              )
              return
            }
            if (enforceAlpha) {
              const normalized = normalizeAlpha(current)
              if (normalized && normalized !== current) {
                root.style.setProperty(name, normalized)
              }
            }
          } catch {
            // ignore if we cannot read the computed style (eg. tests)
          }
        }
        ensureToken(
          '--vscode-terminal-findMatchBackground',
          DEFAULT_FIND_MATCH_BACKGROUND,
          { enforceAlpha: true }
        )
        ensureToken(
          '--vscode-terminal-findMatchHighlightBackground',
          'rgba(234, 92, 0, 0.33)'
        )
      }
    }
  }

  apply()

  // Re-apply when our theming layer updates <style id="vscode-theme">
  const styleEl = document.getElementById('vscode-theme')
  const themeObserver =
    styleEl != null ? new MutationObserver(apply) : undefined
  if (styleEl && themeObserver) {
    themeObserver.observe(styleEl, {
      characterData: true,
      childList: true,
      subtree: true,
    })
  }

  // Also watch for area class changes on <html>
  const rootObserver = new MutationObserver(apply)
  rootObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class'],
  })

  return {
    refresh: apply,
    dispose: () => {
      themeObserver?.disconnect()
      rootObserver.disconnect()
    },
  }
}
