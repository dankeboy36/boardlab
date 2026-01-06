// @ts-check
import { indexedDB } from 'fake-indexeddb'
import { createElement, forwardRef } from 'react'
import { vi } from 'vitest'

/**
 * @param {string} tag Display name for the stub
 * @param {string} [nativeTag] Custom element tag to render (defaults to 'div')
 */
const makeStub = (tag, nativeTag) => {
  const Comp = forwardRef((props, ref) => {
    const { children, ...rest } = /** @type {Record<string, any>} */ (
      props || {}
    )
    /** @type {Record<string, any>} */
    const filtered = {}
    for (const [k, v] of Object.entries(rest)) {
      // Drop synthetic event mapping props like onVscTabsSelect etc.
      if (/^onVsc[A-Z]/.test(k)) continue
      // Drop noisy non-standard props we don't need in tests
      if (
        k === 'selectedIndex' ||
        k === 'alwaysShowHeaderActions' ||
        k === 'panel'
      ) {
        continue
      }
      // Avoid boolean attribute warnings by skipping boolean props on stubs
      if (typeof v === 'boolean') continue
      filtered[k] = v
    }
    return createElement(
      nativeTag || 'div',
      { 'data-mock': tag, ref, ...filtered },
      children
    )
  })
  Comp.displayName = tag
  return Comp
}

vi.mock('vscode-react-elements-x', () => ({
  VscodeTabs: makeStub('VscodeTabs', 'vscode-tabs'),
  VscodeTabHeader: makeStub('VscodeTabHeader', 'vscode-tab-header'),
  VscodeTabPanel: makeStub('VscodeTabPanel', 'vscode-tab-panel'),
  VscodeToolbarContainer: makeStub(
    'VscodeToolbarContainer',
    'vscode-toolbar-container'
  ),
  VscodeBadge: makeStub('VscodeBadge', 'vscode-badge'),
  VscodeToolbarButton: makeStub('VscodeToolbarButton', 'vscode-toolbar-button'),
  VscodeIcon: makeStub('VscodeIcon', 'vscode-icon'),
  VscodeLabel: makeStub('VscodeLabel', 'vscode-label'),
  VscodeTextfield: makeStub('VscodeTextfield', 'vscode-textfield'),
  VscodeTextarea: makeStub('VscodeTextarea', 'vscode-textarea'),
  VscodeSingleSelect: makeStub('VscodeSingleSelect', 'vscode-single-select'),
  VscodeMultiSelect: makeStub('VscodeMultiSelect', 'vscode-multi-select'),
  VscodeOption: makeStub('VscodeOption', 'vscode-option'),
  VscodeCollapsible: makeStub('VscodeCollapsible', 'vscode-collapsible'),
  VscodeFormContainer: makeStub('VscodeFormContainer', 'vscode-form-container'),
  VscodeFormGroup: makeStub('VscodeFormGroup', 'vscode-form-group'),
  VscodeFormHelper: makeStub('VscodeFormHelper', 'vscode-form-helper'),
  VscodeSplitLayout: makeStub('VscodeSplitLayout', 'vscode-split-layout'),
  VscodeTable: makeStub('VscodeTable', 'vscode-table'),
  VscodeTableBody: makeStub('VscodeTableBody', 'vscode-table-body'),
  VscodeTableHeader: makeStub('VscodeTableHeader', 'vscode-table-header'),
  VscodeTableHeaderCell: makeStub(
    'VscodeTableHeaderCell',
    'vscode-table-header-cell'
  ),
  VscodeTableCell: makeStub('VscodeTableCell', 'vscode-table-cell'),
  VscodeTableRow: makeStub('VscodeTableRow', 'vscode-table-row'),
  VscodeProgressBar: makeStub('VscodeProgressBar', 'vscode-progress-bar'),
  VscodeProgressRing: makeStub('VscodeProgressRing', 'vscode-progress-ring'),
  VscodeContextMenu: makeStub('VscodeContextMenu', 'vscode-context-menu'),
  VscodeContextMenuItem: makeStub(
    'VscodeContextMenuItem',
    'vscode-context-menu-item'
  ),
  VscodeButton: makeStub('VscodeButton', 'vscode-button'),
  VscodeButtonGroup: makeStub('VscodeButtonGroup', 'vscode-button-group'),
  VscodeScrollable: makeStub('VscodeScrollable', 'vscode-scrollable'),
  VscodeTree: makeStub('VscodeTree', 'vscode-tree'),
  VscodeTreeItem: makeStub('VscodeTreeItem', 'vscode-tree-item'),
}))

// Also mock direct imports of the underlying elements used only for typing
vi.mock('vscode-elements-x', () => {
  class VscodeTextfield extends (globalThis.HTMLElement || class {}) {}
  return { VscodeTextfield }
})

// Mock xterm and add-ons to avoid Canvas and DOM dependencies in JSDOM
vi.mock('@xterm/xterm', () => {
  class Terminal {
    constructor() {
      this.rows = 0
      this.buffer = {
        active: {
          length: 0,
          viewportY: 0,
          getLine() {
            return null
          },
        },
      }
      this.options = {}
    }

    loadAddon() {}
    open() {}
    write() {}
    clear() {}
    dispose() {}
    focus() {}
  }
  return { Terminal }
})

vi.mock('@xterm/addon-fit', () => {
  class FitAddon {
    fit() {}
  }
  return { FitAddon }
})

vi.mock('@xterm/addon-search', () => {
  class SearchAddon {
    findNext() {}
    findPrevious() {}
    clearDecorations() {}
    onDidChangeResults() {
      return { dispose() {} }
    }
  }
  return { SearchAddon }
})

// Minimal ResizeObserver polyfill for tests
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  }
}

// Polyfill indexedDB for tests
if (!globalThis.indexedDB) {
  globalThis.indexedDB = indexedDB
}

// Polyfill matchMedia for libraries that expect it (e.g., uPlot)
if (typeof globalThis.matchMedia !== 'function') {
  globalThis.matchMedia =
    /** @type {any} */
    (query) => ({
      matches: false,
      media: String(query || ''),
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return false
      },
    })
}

// Mock uPlot to avoid using Canvas in JSDOM
vi.mock('uplot', () => {
  class UPlotMock {
    constructor(opts, data, root) {
      this.opts = opts
      this.data = data
      this.root = root
      this.series = [{}, { min: -1, max: 1 }]
    }

    setSize() {}
    setScale() {}
    destroy() {}
    setData(_data) {
      this.data = _data
    }
  }
  return { default: UPlotMock }
})

// Mock uplot-react to avoid Canvas in tests
vi.mock('uplot-react', () => {
  function UplotReactMock() {
    return null
  }
  return { default: UplotReactMock }
})
