// @ts-check
import { createElement, forwardRef } from 'react'
import { vi } from 'vitest'

/**
 * Removes props that would generate console noise when rendered on simple
 * stubs.
 *
 * - Drops boolean attributes.
 * - Drops VS Code custom event handlers (onVsc...).
 * - Leaves everything else intact so tests can still inspect props such as
 *   title/aria-*.
 *
 * @param {Record<string, any>} props
 */
function scrubProps(props) {
  /** @type {Record<string, any>} */
  const sanitized = {}
  for (const [key, value] of Object.entries(props ?? {})) {
    if (typeof value === 'boolean') {
      if (key === 'disabled') {
        sanitized[key] = value
      }
      continue
    }
    if (/^onVsc[A-Z]/.test(key)) continue
    sanitized[key] = value
  }
  return sanitized
}

/**
 * Builds a very small React wrapper around a plain element so React Testing
 * Library can interact with VS Code web components without pulling in their
 * heavyweight implementations.
 *
 * @param {string} displayName
 * @param {string} [tagName]
 */
function stubElement(displayName, tagName = 'div') {
  const Component = forwardRef((props, ref) =>
    createElement(
      tagName,
      { ref, 'data-mock': displayName, ...scrubProps(props) },
      props?.children
    )
  )
  Component.displayName = displayName
  return Component
}

// Minimal set of VS Code element wrappers that the monitor UI relies on.
vi.mock('vscode-react-elements-x', () => {
  const registry = {
    VscodeTabs: stubElement('VscodeTabs', 'vscode-tabs'),
    VscodeTabHeader: stubElement('VscodeTabHeader', 'vscode-tab-header'),
    VscodeTabPanel: stubElement('VscodeTabPanel', 'vscode-tab-panel'),
    VscodeToolbarContainer: stubElement(
      'VscodeToolbarContainer',
      'vscode-toolbar-container'
    ),
    VscodeToolbarButton: stubElement(
      'VscodeToolbarButton',
      'vscode-toolbar-button'
    ),
    VscodeIcon: stubElement('VscodeIcon', 'vscode-icon'),
    VscodeBadge: stubElement('VscodeBadge', 'vscode-badge'),
    VscodeButton: stubElement('VscodeButton', 'vscode-button'),
    VscodeButtonGroup: stubElement('VscodeButtonGroup', 'vscode-button-group'),
    VscodeTextfield: stubElement('VscodeTextfield', 'vscode-textfield'),
    VscodeTextarea: stubElement('VscodeTextarea', 'textarea'),
    VscodeSingleSelect: stubElement(
      'VscodeSingleSelect',
      'vscode-single-select'
    ),
    VscodeMultiSelect: stubElement('VscodeMultiSelect', 'vscode-multi-select'),
    VscodeOption: stubElement('VscodeOption', 'vscode-option'),
    VscodeSplitLayout: stubElement('VscodeSplitLayout', 'vscode-split-layout'),
    VscodeContextMenu: stubElement('VscodeContextMenu', 'vscode-context-menu'),
    VscodeContextMenuItem: stubElement(
      'VscodeContextMenuItem',
      'vscode-context-menu-item'
    ),
    VscodeScrollable: stubElement('VscodeScrollable', 'vscode-scrollable'),
    VscodeTree: stubElement('VscodeTree', 'vscode-tree'),
    VscodeTreeItem: stubElement('VscodeTreeItem', 'vscode-tree-item'),
  }
  return registry
})

// The monitor components never talk directly to the element classes, but some modules import
// them for typings. Provide a lightweight placeholder to avoid module resolution failures.
vi.mock('vscode-elements-x', () => ({}))

// Mock xterm and its add-ons so tests do not require a Canvas implementation.
vi.mock('@xterm/xterm', () => {
  class Terminal {
    constructor() {
      this.options = {}
      this.element = null
    }

    loadAddon() {}
    write() {}
    clear() {}
    dispose() {}
    focus() {}
    get rows() {
      return 0
    }

    open(element) {
      this.element = element ?? null
    }
  }

  return { Terminal }
})

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}))

vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class {
    findNext() {}
    findPrevious() {}
    clearDecorations() {}
    onDidChangeResults() {
      return { dispose() {} }
    }
  },
}))

// Provide very small DOM shims that some components expect.
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  }
}

if (typeof globalThis.matchMedia !== 'function') {
  globalThis.matchMedia = (query) => ({
    matches: false,
    media: String(query ?? ''),
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
