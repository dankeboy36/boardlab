import type { Store } from '@boardlab/base'
import type {
  Resource,
  Resources,
  SearchFilterParams,
} from '@boardlab/protocol'
import React, { createContext } from 'react'
import type { Messenger } from 'vscode-messenger-webview'

export interface ResourcesContextParams<
  T extends Resource = Resource,
  F extends SearchFilterParams = SearchFilterParams,
> {
  readonly store: Store
  readonly resources: Resources<T, F>
}

export const ResourcesContext = createContext<ResourcesContextParams>(
  {} as ResourcesContextParams
)

export interface WithResourcesContextParams<
  T extends Resource = Resource,
  F extends SearchFilterParams = SearchFilterParams,
  S extends Resources<T, F> = Resources<T, F>,
> {
  readonly store: Store
  readonly messenger?: Messenger | undefined
  readonly children: React.ReactNode
  readonly createService: (messenger: Messenger | undefined) => S
}

export const WithResourcesContext = function <
  T extends Resource = Resource,
  F extends SearchFilterParams = SearchFilterParams,
  S extends Resources<T, F> = Resources<T, F>,
>(params: WithResourcesContextParams<T, F, S>) {
  const { store, messenger, createService, children } = params
  return (
    <ResourcesContext.Provider
      value={{ store, resources: createService(messenger) }}
    >
      {children}
    </ResourcesContext.Provider>
  )
}
