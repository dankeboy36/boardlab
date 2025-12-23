// @ts-check

/** Resolve a CSS variable to a concrete color string. */
export function resolveCssVar(name) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name)
    return (v || '').trim()
  } catch {
    return ''
  }
}

/** Convert color to rgba(..., alpha). Supports #rgb/#rrggbb and rgb/rgba. */
export function withAlpha(color, a) {
  if (!color) return color
  const c = color.trim()
  if (/^#([0-9a-f]{3}){1,2}$/i.test(c)) {
    let r, g, b
    if (c.length === 4) {
      r = parseInt(c[1] + c[1], 16)
      g = parseInt(c[2] + c[2], 16)
      b = parseInt(c[3] + c[3], 16)
    } else {
      r = parseInt(c.slice(1, 3), 16)
      g = parseInt(c.slice(3, 5), 16)
      b = parseInt(c.slice(5, 7), 16)
    }
    return `rgba(${r}, ${g}, ${b}, ${a})`
  }
  const m = c.match(/rgba?\(([^)]+)\)/i)
  if (m) {
    const parts = m[1].split(',').map((s) => s.trim())
    const [r, g, b] = parts
    return `rgba(${r}, ${g}, ${b}, ${a})`
  }
  return c
}

/**
 * Build an ordered series color palette from VS Code theme variables.
 *
 * @param {{ useAnsiColors?: boolean }} [options]
 */
export function buildPlotPalette(options = {}) {
  const useAnsiColors = !!options.useAnsiColors
  const varNames = useAnsiColors
    ? [
        '--vscode-terminal-ansiBlue',
        '--vscode-terminal-ansiGreen',
        '--vscode-terminal-ansiRed',
        '--vscode-terminal-ansiYellow',
        '--vscode-terminal-ansiMagenta',
        '--vscode-terminal-ansiCyan',
        '--vscode-terminal-ansiWhite',
        '--vscode-terminal-ansiBrightBlack',
      ]
    : [
        '--vscode-charts-blue',
        '--vscode-charts-green',
        '--vscode-charts-red',
        '--vscode-charts-yellow',
        '--vscode-charts-purple',
        '--vscode-charts-orange',
        '--vscode-focusBorder',
        '--vscode-scmGraph-foreground4',
      ]

  const fallbacks = [
    '#1a85ff',
    '#388a34',
    '#e51400',
    '#d18616',
    '#652d90',
    '#bf8803',
    '#005fb8',
    '#40b0a6',
  ]

  return varNames.map((vn, i) => resolveCssVar(vn) || fallbacks[i] || '#3b3b3b')
}

/**
 * Checks if plot theme CSS variables are present (theme loaded) for either
 * charts or ANSI palette.
 *
 * @param {{ useAnsiColors?: boolean }} [options]
 */
export function isPlotThemeReady(options = {}) {
  const useAnsiColors = !!options.useAnsiColors
  const vars = useAnsiColors
    ? [
        '--vscode-terminal-ansiRed',
        '--vscode-terminal-ansiGreen',
        '--vscode-terminal-ansiBlue',
      ]
    : ['--vscode-charts-blue', '--vscode-charts-green', '--vscode-charts-red']
  // Ready if at least one key var resolves to a non-empty value
  return vars.some((vn) => !!resolveCssVar(vn))
}

/**
 * Subscribe to theme changes (same signals the terminal uses) and invoke cb.
 * Returns a disposer function.
 */
export function onPlotThemeChange(cb) {
  const styleEl = document.getElementById('vscode-theme')
  const obs = new MutationObserver(() => cb())
  if (styleEl) {
    obs.observe(styleEl, {
      characterData: true,
      childList: true,
      subtree: true,
    })
  }
  const rootObs = new MutationObserver(() => cb())
  rootObs.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class'],
  })
  return () => {
    try {
      obs.disconnect()
    } catch {}
    try {
      rootObs.disconnect()
    } catch {}
  }
}

/**
 * Attach theme syncing to a uPlot instance. Updates series stroke/fill colors
 * from current VS Code CSS variables and re-applies on theme changes.
 *
 * @param {uPlot} u
 * @param {{ useAnsiColors?: boolean; alpha?: number }} [options]
 * @returns {{ dispose(): void; getColor(idx: number): string }}
 */
export function attachUplotTheme(u, options = {}) {
  const alpha = typeof options.alpha === 'number' ? options.alpha : 0.12
  let palette = buildPlotPalette({ useAnsiColors: options.useAnsiColors })

  const apply = () => {
    try {
      palette = buildPlotPalette({ useAnsiColors: options.useAnsiColors })
      const axisLabelColor =
        resolveCssVar('--vscode-charts-foreground') || '#d4d4d4'
      const axisLineColor =
        resolveCssVar('--vscode-chart-axis') || 'rgba(255, 255, 255, 0.45)'
      const gridLineColor =
        resolveCssVar('--vscode-chart-guide') || 'rgba(255, 255, 255, 0.2)'
      for (let i = 1; i < u.series.length; i++) {
        const color = palette[(i - 1) % palette.length]
        // ensure function forms to satisfy uPlot's cacheStrokeFill path
        u.series[i].stroke = () => color
        u.series[i].fill = () => withAlpha(color, alpha)
      }
      for (const axis of u.axes) {
        if (!axis) continue
        axis.stroke = () => axisLabelColor
        if (axis.grid) {
          axis.grid.stroke = () => gridLineColor
          if (axis.grid.width == null) axis.grid.width = 1
        }
        if (axis.ticks) {
          axis.ticks.stroke = () => axisLineColor
          if (axis.ticks.width == null) axis.ticks.width = 1
        }
        if (axis.border) {
          axis.border.stroke = () => axisLineColor
          if (axis.border.width == null) axis.border.width = 1
        }
      }
      u.redraw(false, false)
    } catch {}
  }

  apply()

  const styleEl = document.getElementById('vscode-theme')
  const obs = new MutationObserver(apply)
  if (styleEl) {
    obs.observe(styleEl, {
      characterData: true,
      childList: true,
      subtree: true,
    })
  }
  const rootObs = new MutationObserver(apply)
  rootObs.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class'],
  })

  return {
    dispose() {
      try {
        obs.disconnect()
      } catch {}
      try {
        rootObs.disconnect()
      } catch {}
    },
    getColor(idx) {
      return palette[idx % palette.length]
    },
  }
}
