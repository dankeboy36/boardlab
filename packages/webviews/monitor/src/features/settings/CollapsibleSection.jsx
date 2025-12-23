// @ts-check
import { useRef } from 'react'
import { VscodeCollapsible, VscodeIcon } from 'vscode-react-elements-x'

/**
 * Generic settings collapsible with built-in Expand/Collapse All actions. The
 * actions affect all descendant <vscode-collapsible> elements within this
 * section (recursively), but do not toggle this section itself.
 *
 * Props:
 *
 * - Heading: string – title text
 * - Open?: boolean – default open state (default false)
 * - DecorationIcon?: string – codicon name for a leading decoration icon
 * - AlwaysShowHeaderActions?: boolean – show actions without hover (default true)
 * - Children: React.ReactNode – content rendered inside the body
 */
export default function CollapsibleSection({
  heading,
  open = false,
  decorationIcon = null,
  alwaysShowHeaderActions = true,
  children,
}) {
  const rootRef = useRef(null)

  return (
    <VscodeCollapsible
      ref={rootRef}
      heading={heading}
      open={open}
      alwaysShowHeaderActions={alwaysShowHeaderActions}
    >
      {!!decorationIcon && (
        <VscodeIcon slot="decorations" name={decorationIcon} />
      )}
      {children}
    </VscodeCollapsible>
  )
}
