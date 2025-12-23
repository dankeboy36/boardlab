// @ts-check
import { VscodeIcon, VscodeToolbarContainer } from 'vscode-react-elements-x'

/**
 * @typedef {Object} MonitorPlayStopButtonProps
 * @property {boolean} started
 * @property {boolean} canControl
 * @property {() => void} onPlay
 * @property {() => void} onStop
 */

/** @param {MonitorPlayStopButtonProps} props */
export default function MonitorPlayStopButton({
  started,
  canControl,
  onPlay,
  onStop,
}) {
  const startEnabled = canControl && !started
  const stopEnabled = !!started

  if (started) {
    return (
      <VscodeToolbarContainer>
        <VscodeIcon
          name="debug-stop"
          label="Stop"
          actionIcon
          title="Stop monitor"
          onClick={stopEnabled ? onStop : undefined}
          style={{
            color: stopEnabled
              ? 'var(--vscode-debugIcon-disconnectForeground, #a1260d)'
              : 'var(--vscode-disabledForeground, #999999)',
            pointerEvents: stopEnabled ? undefined : 'none',
            opacity: stopEnabled ? 1 : 0.7,
          }}
        />
      </VscodeToolbarContainer>
    )
  }

  return (
    <VscodeToolbarContainer>
      <VscodeIcon
        name="play"
        label="Start"
        actionIcon
        title="Start (open monitor)"
        onClick={startEnabled ? onPlay : undefined}
        style={{
          color: startEnabled
            ? 'var(--vscode-debugIcon-startForeground, #388a34)'
            : 'var(--vscode-disabledForeground, #999999)',
          pointerEvents: startEnabled ? undefined : 'none',
          opacity: startEnabled ? 1 : 0.75,
        }}
      />
    </VscodeToolbarContainer>
  )
}
