// @ts-check
import {
  VscodeToolbarButton,
  VscodeToolbarContainer,
} from 'vscode-react-elements-x'

/**
 * Toolbar above the terminal area.
 *
 * @param {{
 *   onCopy: () => void
 *   onSave: () => void
 *   onClear: () => void
 *   scrollLock: boolean
 *   onToggleScrollLock: () => void
 *   style?: import('react').CSSProperties
 * }} props
 */
export default function TerminalToolbar({
  onCopy,
  onSave,
  onClear,
  scrollLock,
  onToggleScrollLock,
  style,
}) {
  return (
    <VscodeToolbarContainer style={style}>
      <VscodeToolbarButton
        icon="save"
        label="Save"
        title="Save to file"
        onClick={onSave}
      />
      <VscodeToolbarButton
        icon="copy"
        label="Copy"
        title="Copy all"
        onClick={onCopy}
      />
      <VscodeToolbarButton
        icon="clear-all"
        label="Clear"
        title="Clear terminal"
        onClick={onClear}
      />
      <VscodeToolbarButton
        icon={scrollLock ? 'lock' : 'unlock'}
        label={scrollLock ? 'Locked' : 'Unlocked'}
        title="Toggle scroll lock"
        onClick={onToggleScrollLock}
      />
    </VscodeToolbarContainer>
  )
}
