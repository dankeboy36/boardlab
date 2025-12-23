import {
  PlatformFilterType,
  PlatformFilterTypeLiterals,
} from '@boardlab/protocol'
import { App, FilterDefinition } from '@boardlab/resources'
import React from 'react'
import { createRoot } from 'react-dom/client'

import { createPlatforms as createService } from './platforms'

const platformTypeFilter: FilterDefinition<PlatformFilterType> = {
  key: 'type',
  label: 'Type:',
  defaultValue: PlatformFilterTypeLiterals[0],
  values: [...PlatformFilterTypeLiterals],
}
const filterDefinitions = [platformTypeFilter]

// https://react.dev/blog/2022/03/08/react-18-upgrade-guide#updates-to-client-rendering-apis

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App filterDefinitions={filterDefinitions} createService={createService} />
  </React.StrictMode>
)
