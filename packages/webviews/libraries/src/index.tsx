import {
  LibraryFilterTopic,
  LibraryFilterTopicLiterals,
  LibraryFilterType,
  LibraryFilterTypeLiterals,
} from '@boardlab/protocol'
import { App, FilterDefinition } from '@boardlab/resources'
import React from 'react'
import { createRoot } from 'react-dom/client'

import { createLibraries as createService } from './libraries'

const libraryTypeFilter: FilterDefinition<LibraryFilterType> = {
  key: 'type',
  label: 'Type:',
  defaultValue: LibraryFilterTypeLiterals[0],
  values: [...LibraryFilterTypeLiterals],
}
const libraryTopicFilter: FilterDefinition<LibraryFilterTopic> = {
  key: 'topic',
  label: 'Topic:',
  defaultValue: LibraryFilterTopicLiterals[0],
  values: [...LibraryFilterTopicLiterals],
}
const filterDefinitions = [libraryTypeFilter, libraryTopicFilter]

// https://react.dev/blog/2022/03/08/react-18-upgrade-guide#updates-to-client-rendering-apis

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App filterDefinitions={filterDefinitions} createService={createService} />
  </React.StrictMode>
)
