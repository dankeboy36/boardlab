import { cloneElement, Fragment, isValidElement, useRef } from 'react'
import { VscodeIcon, VscodeTree, VscodeTreeItem } from 'vscode-react-elements-x'

export type TreeExpandMode = 'singleClick' | 'doubleClick'

export type TreeActionSpec = {
  icon: string
  ariaLabel: string
  title?: string
  onClick?: (ev: React.MouseEvent) => void
  className?: string
  disabled?: boolean
  preserveFocus?: boolean
  dataAttrs?: Record<string, string | number | boolean | undefined>
}

export type TreeNode = {
  id?: string
  label: React.ReactNode
  icon?: string | React.ReactElement
  openedIcon?: string | React.ReactElement
  description?: React.ReactNode
  decoration?: React.ReactNode
  actions?: React.ReactNode | ReadonlyArray<React.ReactNode | TreeActionSpec>
  className?: string
  dataAttrs?: Record<string, string | number | boolean | undefined>
  branch?: boolean
  open?: boolean
  selected?: boolean
  onClick?: (ev: React.MouseEvent<any>) => void
  /**
   * Which action to invoke when user presses Enter on the item.
   *
   * - 'last' (default): the last enabled action spec
   * - 'first': the first enabled action spec
   * - Number: index within the enabled action specs
   */
  defaultAction?: 'last' | 'first' | number
  children?: ReadonlyArray<TreeNode>
}

export type TreeProps = {
  items: ReadonlyArray<TreeNode>
  className?: string
  ariaLabel?: string
  expandMode?: TreeExpandMode
  multiSelect?: boolean
}

function renderActions(
  actions: TreeNode['actions']
): React.ReactNode | undefined {
  if (!actions) {
    return undefined
  }
  const toNode = (item: React.ReactNode | TreeActionSpec, idx: number) => {
    if (isValidElement(item)) {
      // Wrap custom elements to guard tree toggling on action clicks
      const el = item as React.ReactElement<any>
      const origOnClick = (el.props as any)?.onClick as
        | ((ev: React.MouseEvent) => void)
        | undefined
      const origOnMouseDownCapture = (el.props as any)?.onMouseDownCapture as
        | ((ev: React.MouseEvent) => void)
        | undefined
      return cloneElement(el, {
        key: idx,
        onMouseDownCapture: (ev: React.MouseEvent) => {
          ev.preventDefault()
          ev.stopPropagation()
          origOnMouseDownCapture?.(ev)
        },
        onClick: (ev: React.MouseEvent) => {
          ev.preventDefault()
          ev.stopPropagation()
          origOnClick?.(ev)
        },
      })
    }
    if (typeof item === 'object' && item && 'icon' in item) {
      const spec = item as TreeActionSpec
      const {
        icon,
        ariaLabel,
        title,
        onClick,
        className,
        disabled,
        dataAttrs,
        preserveFocus,
      } = spec
      // Do not render disabled actions at all
      if (disabled) {
        return null as any
      }
      const baseProps: Record<string, unknown> = {
        key: idx,
        actionIcon: true,
        name: icon,
        'aria-label': ariaLabel,
        title,
        'data-preserve-focus': preserveFocus ? 'true' : undefined,
        tabIndex: preserveFocus ? -1 : undefined,
        onPointerDownCapture: (ev: any) => {
          ev.preventDefault()
          ev.stopPropagation()
        },
        onMouseDownCapture: (ev: React.MouseEvent) => {
          ev.preventDefault()
          ev.stopPropagation()
        },
        onClickCapture: (ev: React.MouseEvent) => {
          ev.preventDefault()
          ev.stopPropagation()
          onClick?.(ev)
        },
        onFocusCapture: preserveFocus
          ? (ev: any) => {
              try {
                ;(ev.currentTarget as HTMLElement)?.blur?.()
              } catch {}
            }
          : undefined,
        className,
      }
      const propsWithData = applyDataAttributes(baseProps, dataAttrs)
      return <VscodeIcon {...(propsWithData as any)} />
    }
    return <Fragment key={idx}>{item}</Fragment>
  }

  const nodes = Array.isArray(actions)
    ? actions.map((a, i) => toNode(a, i))
    : [<Fragment key={0}>{actions as React.ReactNode}</Fragment>]

  return (
    <div slot="actions" className="toolbar-group">
      {nodes}
    </div>
  )
}

function renderIconForSlot(
  icon: string | React.ReactElement | undefined,
  slot: 'icon-branch' | 'icon-branch-opened' | 'icon-leaf'
): React.ReactNode | null {
  if (!icon) return null
  if (typeof icon === 'string') {
    return <VscodeIcon slot={slot} name={icon} />
  }
  if (isValidElement(icon)) {
    return cloneElement(icon as any, { slot } as any)
  }
  return null
}

function renderIcons(
  icon: TreeNode['icon'],
  openedIcon: TreeNode['openedIcon'],
  isBranch: boolean
): React.ReactNode | undefined {
  if (!icon && !openedIcon) return undefined
  if (isBranch) {
    // Provide both closed and opened branch icons; fallback to the same icon if openedIcon is not set.
    return (
      <>
        {renderIconForSlot(icon, 'icon-branch')}
        {renderIconForSlot(openedIcon ?? icon, 'icon-branch-opened')}
      </>
    )
  }
  return renderIconForSlot(icon, 'icon-leaf') ?? undefined
}

function applyDataAttributes(
  props: Record<string, unknown>,
  data?: TreeNode['dataAttrs']
): Record<string, unknown> {
  if (!data) {
    return props
  }
  const withData: Record<string, unknown> = { ...props }
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue
    withData[`data-${key}`] = String(value)
  }
  return withData
}

function toEnabledActionSpecs(actions: TreeNode['actions']): TreeActionSpec[] {
  if (!actions) return []
  const arr = Array.isArray(actions) ? actions : [actions]
  const specs: TreeActionSpec[] = []
  for (const a of arr) {
    if (isValidElement(a)) continue
    if (typeof a === 'object' && a && 'icon' in (a as any)) {
      const spec = a as TreeActionSpec
      if (!spec.disabled) specs.push(spec)
    }
  }
  return specs
}

function selectDefaultAction(node: TreeNode): TreeActionSpec | undefined {
  const specs = toEnabledActionSpecs(node.actions)
  if (!specs.length) return undefined
  const pref = node.defaultAction ?? 'last'
  if (pref === 'first') return specs[0]
  if (pref === 'last') return specs[specs.length - 1]
  if (typeof pref === 'number') {
    const idx = Math.max(0, Math.min(specs.length - 1, pref))
    return specs[idx]
  }
  return specs[specs.length - 1]
}

function renderItem(node: TreeNode): React.ReactElement {
  const hasChildren = (node.children?.length ?? 0) > 0
  const isBranch = node.branch ?? hasChildren
  const preferred = node.defaultAction ?? 'last'
  const baseProps: Record<string, unknown> = {
    branch: isBranch,
    open: node.open,
    selected: node.selected,
    className: node.className,
    key: node.id ?? (typeof node.label === 'string' ? node.label : undefined),
    'data-default-action':
      typeof preferred === 'number' ? String(preferred) : preferred,
  }
  const itemProps = applyDataAttributes(baseProps, node.dataAttrs)
  const defaultAction = selectDefaultAction(node)

  return (
    <VscodeTreeItem
      {...(itemProps as any)}
      onClickCapture={node.onClick as any}
      onKeyDown={(ev: any) => {
        if (ev?.key === 'Enter' && defaultAction?.onClick) {
          try {
            ev.preventDefault()
            ev.stopPropagation()
          } catch {}
          // Invoke without toggling/collapsing behavior
          try {
            // Create a minimal synthetic event object for consumers
            defaultAction.onClick(ev)
          } catch {
            // swallow
          }
        }
      }}
    >
      {renderIcons(node.icon, node.openedIcon, isBranch)}
      <span className="tree-item__label">
        <span className="tree-item__labelText">{node.label}</span>
      </span>
      {node.description ? (
        <span slot="description">{node.description}</span>
      ) : null}
      {node.decoration ? (
        <span slot="decoration">{node.decoration}</span>
      ) : null}
      {renderActions(node.actions)}
      {hasChildren ? node.children!.map((child) => renderItem(child)) : null}
    </VscodeTreeItem>
  )
}

export function Tree({
  items,
  className,
  ariaLabel,
  expandMode = 'singleClick',
  multiSelect = false,
}: TreeProps): React.ReactElement {
  // Unique marker to distinguish this tree in the DOM for any external queries
  const instanceIdRef = useRef<number>(0)
  if (!instanceIdRef.current) {
    ;(Tree as any)._inst = ((Tree as any)._inst || 0) + 1
    instanceIdRef.current = (Tree as any)._inst
  }
  const instanceId = instanceIdRef.current
  const isPreserveFocusEvent = (ev: any): boolean => {
    try {
      const native: any = ev?.nativeEvent ?? ev
      const path: any[] =
        typeof native.composedPath === 'function' ? native.composedPath() : []
      const check = (el: any) =>
        !!el &&
        typeof el.getAttribute === 'function' &&
        el.getAttribute('data-preserve-focus') === 'true'
      if (Array.isArray(path) && path.some(check)) return true
      let t: any = ev?.target
      while (t) {
        if (check(t)) return true
        t = t.parentElement
      }
    } catch {}
    return false
  }
  return (
    <VscodeTree
      className={className}
      data-ardunno-tree={String(instanceId)}
      aria-label={ariaLabel}
      expandMode={expandMode}
      multiSelect={multiSelect}
      onFocusCapture={(ev: any) => {
        try {
          const treeEl = ev.currentTarget as HTMLElement
          // Prefer a focused item; otherwise, ensure the selected item is marked active
          const focused = treeEl?.querySelector('vscode-tree-item:focus') as any
          const selected = treeEl?.querySelector(
            'vscode-tree-item[selected]'
          ) as any
          const target = focused || selected
          if (target) {
            try {
              target.active = true
            } catch {}
          }
        } catch {}
      }}
      onPointerDownCapture={(ev: any) => {
        if (isPreserveFocusEvent(ev)) {
          try {
            ev.preventDefault()
            ev.stopPropagation()
            ;(document.activeElement as any)?.blur?.()
          } catch {}
        }
      }}
      onMouseDownCapture={(ev: any) => {
        if (isPreserveFocusEvent(ev)) {
          try {
            ev.preventDefault()
            ev.stopPropagation()
            ;(document.activeElement as any)?.blur?.()
          } catch {}
        }
      }}
      onClickCapture={(ev: any) => {
        if (!isPreserveFocusEvent(ev)) return
        try {
          ev.preventDefault()
          ev.stopPropagation()
          const native: any = ev?.nativeEvent ?? ev
          const path: any[] =
            typeof native.composedPath === 'function'
              ? native.composedPath()
              : []
          const hasContext = (el: any) =>
            !!el &&
            typeof el.getAttribute === 'function' &&
            !!el.getAttribute('data-vscode-context')
          const targetEl = (
            Array.isArray(path) ? path.find(hasContext) : null
          ) as HTMLElement | null
          if (targetEl) {
            targetEl.dispatchEvent(
              new MouseEvent('contextmenu', {
                bubbles: true,
                clientX: native.clientX,
                clientY: native.clientY,
              })
            )
          }
        } catch {}
      }}
      onKeyDownCapture={(ev: any) => {
        if (!ev || ev.key !== 'Enter') return
        // Avoid triggering when an input element is focused
        const t = ev.target as HTMLElement | undefined
        const tag = (t?.tagName || '').toLowerCase()
        if (
          tag === 'input' ||
          tag === 'textarea' ||
          (t as any)?.isContentEditable
        ) {
          return
        }
        try {
          const treeEl = ev.currentTarget as HTMLElement
          // Prefer focused item over selected when present (aligns with VS Code tree behavior)
          const focused = treeEl?.querySelector(
            ':scope vscode-tree-item:focus'
          ) as HTMLElement | null
          const selected = treeEl?.querySelector(
            ':scope vscode-tree-item[selected]'
          ) as HTMLElement | null
          const itemEl =
            focused && treeEl.contains(focused) ? focused : selected
          if (!itemEl) return
          const pref = itemEl.getAttribute('data-default-action') || 'last'
          const actionsHost = itemEl.querySelector(
            '.toolbar-group'
          ) as HTMLElement | null
          if (!actionsHost) return
          const icons = Array.from(
            actionsHost.querySelectorAll('vscode-icon')
          ) as HTMLElement[]
          if (!icons.length) return
          let targetIcon: HTMLElement | undefined
          if (pref === 'first') targetIcon = icons[0]
          else if (pref === 'last') targetIcon = icons[icons.length - 1]
          else {
            const idx = Math.max(
              0,
              Math.min(icons.length - 1, Number(pref) || 0)
            )
            targetIcon = icons[idx]
          }
          if (targetIcon && typeof (targetIcon as any).click === 'function') {
            ev.preventDefault()
            ev.stopPropagation()
            ;(targetIcon as any).click()
          }
        } catch {}
      }}
    >
      {items.map((item) => renderItem(item))}
    </VscodeTree>
  )
}

export default Tree

/**
 * Activate (select) and focus a tree item within a given tree element. The item
 * is located by the provided CSS selector relative to the tree root. Uses the
 * web component's `active` property and waits for `updateComplete` before
 * focusing, mirroring the official VS Code elements behavior.
 */
export async function activateTreeItem(
  treeRoot: HTMLElement | null | undefined,
  itemSelector: string
): Promise<boolean> {
  try {
    const root = treeRoot as any
    if (!root) return false
    const item = root.querySelector(itemSelector) as any
    if (!item) return false
    try {
      item.active = true
    } catch {}
    const done = () => {
      try {
        item.focus()
      } catch {}
    }
    const p = item?.updateComplete
    if (p && typeof p.then === 'function') {
      try {
        await p
      } catch {}
    }
    done()
    return true
  } catch {
    return false
  }
}
