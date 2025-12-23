// @ts-check
import CollapsibleSection from './CollapsibleSection.jsx'
import TerminalSettings from './TerminalSettings.jsx'

export default function SettingsPanel() {
  return (
    <CollapsibleSection heading="Terminal" open>
      <TerminalSettings />
    </CollapsibleSection>
  )
}
