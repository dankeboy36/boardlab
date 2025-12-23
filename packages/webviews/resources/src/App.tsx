import {
  createVscodeDataContext,
  dispatchContextMenuEvent,
  preventDefaultContextMenuItems,
  useCodiconStylesheet,
  vscode,
} from '@vscode-ardunno/base'
import {
  notifyLibrariesFilterChanged,
  notifyPlatformsFilterChanged,
  Resource,
  Resources,
  SearchFilterParams,
  setLibrariesFilterContext,
  setPlatformsFilterContext,
  Version,
} from '@vscode-ardunno/protocol'
import debounce from 'lodash.debounce'
import React, {
  FormEvent as ReactFormEvent,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Virtuoso } from 'react-virtuoso'
import {
  CancellationToken,
  CancellationTokenImpl,
  HOST_EXTENSION,
} from 'vscode-messenger-common'
import type { Messenger } from 'vscode-messenger-webview'
import {
  VscodeBadge,
  VscodeButton,
  VscodeDivider,
  VscodeIcon,
  VscodeOption,
  VscodeProgressRing,
  VscodeSingleSelect,
  VscodeTextfield,
} from 'vscode-react-elements-x'

import './App.css'
import {
  ResourcesContext,
  ResourcesContextParams,
  WithResourcesContext,
} from './resources'

export interface AppProps<
  T extends Resource = Resource,
  F extends SearchFilterParams = SearchFilterParams,
  S extends Resources<T, F> = Resources<T, F>,
> {
  readonly filterDefinitions: readonly FilterDefinition[]
  readonly createService: (messenger: Messenger | undefined) => S
}

export function App(props: AppProps) {
  useCodiconStylesheet()

  // Close any open vscode-single-select dropdown when the webview loses focus.
  // https://github.com/vscode-elements/elements/issues/546
  useEffect(() => {
    const closeAllSelects = () => {
      const selects = document.querySelectorAll('vscode-single-select')
      selects.forEach((el) => {
        const anyEl = el as any
        try {
          if (typeof anyEl.close === 'function') {
            anyEl.close()
          }
          if ('open' in anyEl) {
            anyEl.open = false
          }
          el.removeAttribute('open')
        } catch {}
      })
    }

    const onWindowBlur = () => closeAllSelects()
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        closeAllSelects()
      }
    }

    window.addEventListener('blur', onWindowBlur)
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      window.removeEventListener('blur', onWindowBlur)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  const { createService, filterDefinitions } = props
  return (
    <WithResourcesContext
      store={vscode}
      messenger={vscode.messenger}
      createService={createService}
    >
      <View context={ResourcesContext} filterDefinitions={filterDefinitions} />
    </WithResourcesContext>
  )
}

export interface FilterDefinition<T = string> {
  readonly key: string
  readonly label: string
  readonly defaultValue: T
  readonly values: readonly T[]
}

interface ViewParams<
  T extends Resource = Resource,
  F extends SearchFilterParams = SearchFilterParams,
> {
  readonly context: React.Context<ResourcesContextParams<T, F>>
  readonly filterDefinitions: readonly FilterDefinition[]
}

function View<T extends Resource = Resource>(params: ViewParams) {
  const { filterDefinitions, context } = params
  const { resources } = useContext(context)
  const [refreshSearch, setRefreshSearch] = useState(0)

  const [noResults, setNoResults] = useState(false)
  const [items, setItems] = useState<T[]>([])
  const [selectedItem, setSelectedItem] =
    useState<SelectedItem<T>>(noSelectedItem())
  const [busyItems, setBusyItems] = useState<string[]>([])

  const search = useCallback(
    async (
      query: string,
      filter: SearchFilterParams,
      token: CancellationToken
    ) => {
      try {
        const result = await resources.search({ query, filter }, token)
        setItems(result as T[])
        setNoResults(result.length === 0)
      } catch (err) {
        if (err instanceof Error && err.message === '') {
          // Weird cancellation error from vscode-messenger-common
          return
        }
        console.error(err)
      }
    },
    [resources]
  )
  const debouncedSearch = useMemo(
    () => debounce(search, 200),
    // refreshSearch is needed to reset the debounce when the index is updated
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [search, refreshSearch]
  )

  const discardSelectedItem = useCallback(() => {
    setSelectedItem(noSelectedItem())
  }, [setSelectedItem])
  const loadBusyItems = useCallback(async () => {
    const result = await resources.busyResources()
    setBusyItems(result)
  }, [resources])
  const markBusy = useCallback(
    (id: string) => {
      setBusyItems((prevBusyItems) => prevBusyItems.concat(id))
    },
    [setBusyItems]
  )
  const markIdle = useCallback(
    (id: string) => {
      setBusyItems((prevBusyItems) =>
        prevBusyItems.filter((busyItem) => busyItem !== id)
      )
      discardSelectedItem()
    },
    [setBusyItems, discardSelectedItem]
  )
  const markInstalled = (params: { id: string; version: string }) => {
    setItems((previousItems) => {
      return previousItems.map((item) => {
        if (item.id === params.id) {
          return {
            ...item,
            installedVersion: params.version,
          }
        }
        return item
      })
    })
  }
  const markAbsent = (params: { id: string }) => {
    setItems((previousItems) => {
      return previousItems.map((item) => {
        if (item.id === params.id) {
          return {
            ...item,
            installedVersion: undefined,
          }
        }
        return item
      })
    })
  }
  const install = async (params: { item: T; version: string }) => {
    const { item, version } = params
    const { id, name } = item
    await resources.install({ id, name, version })
  }
  const uninstall = async (params: { item: T }) => {
    const { item } = params
    const { id, name } = item
    await resources.uninstall({ id, name })
  }

  useEffect(() => {
    const toDispose = [
      resources.onWillInstall((event) => markBusy(event.id)),
      resources.onDidInstall((event) => {
        const { id, version } = event
        markIdle(id)
        markInstalled({ id, version })
      }),
      resources.onDidErrorInstall((event) => markIdle(event.id)),
      resources.onWillUninstall((event) => markBusy(event.id)),
      resources.onDidUninstall((event) => {
        const { id } = event
        markIdle(id)
        markAbsent({ id })
      }),
      resources.onDidErrorUninstall((event) => markIdle(event.id)),
      resources.onDidUpdateIndex(() => setRefreshSearch((prev) => prev + 1)),
    ]
    loadBusyItems()
    return function () {
      let disposable = toDispose.pop()
      while (disposable) {
        try {
          disposable.dispose()
        } catch (e) {
          console.log('Error during disposing resource listeners', e)
        }
        disposable = toDispose.pop()
      }
    }
  }, [resources, loadBusyItems, markIdle, markBusy])

  return (
    <div className="view">
      <Search search={debouncedSearch} filterDefinitions={filterDefinitions} />
      <List
        noResults={noResults}
        items={items}
        selectedItem={selectedItem}
        setSelectedItem={setSelectedItem}
        busyItems={busyItems}
        install={install}
        uninstall={uninstall}
      />
    </div>
  )
}

interface SearchProps {
  readonly search: (
    query: string,
    filter: SearchFilterParams,
    token: CancellationToken
  ) => void
  readonly filterDefinitions: readonly FilterDefinition[]
}

function Search(props: SearchProps) {
  const { search } = props
  const focusSearchInput = useCallback(() => {
    if (typeof document === 'undefined') {
      return
    }
    const host = document.querySelector<HTMLElement>(
      '[data-ardunno-search-input]'
    )
    if (!host) {
      return
    }
    try {
      if (typeof (host as any).focus === 'function') {
        ;(host as any).focus()
      }
    } catch (err) {
      console.error('Failed to focus resources search field', err)
    }
    const input = host.shadowRoot?.querySelector('input')
    if (input instanceof HTMLInputElement) {
      input.focus()
    }
  }, [])
  const initialState = useMemo(() => {
    const persisted =
      (typeof vscode.getState === 'function' ? vscode.getState() : undefined) ??
      (typeof window !== 'undefined'
        ? (window as any).__INITIAL_VSCODE_STATE__
        : undefined)
    if (persisted && typeof persisted === 'object') {
      const query =
        typeof (persisted as any).query === 'string'
          ? (persisted as any).query
          : ''
      const savedFilterRaw =
        (persisted as any).filter &&
        typeof (persisted as any).filter === 'object'
          ? (persisted as any).filter
          : {}
      const savedFilter: Record<string, string> = {}
      for (const [key, value] of Object.entries(savedFilterRaw as any)) {
        if (typeof value === 'string') {
          savedFilter[key] = value
        }
      }
      return {
        query,
        filter: savedFilter,
      }
    }
    return { query: '', filter: {} }
  }, [])

  const [query, setQuery] = useState(initialState.query)
  const [filter, setFilter] = useState<Record<string, string>>(
    initialState.filter
  )

  const onInput = (event: Event | ReactFormEvent) => {
    const target = event?.target as { value?: string } | null
    if (target && typeof target.value === 'string') {
      setQuery(target.value)
    }
  }

  useEffect(() => {
    const token = new CancellationTokenImpl()
    search(query, filter, token)
    return function () {
      token.cancel()
    }
  }, [search, filter, query])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    const timer = window.setTimeout(() => focusSearchInput(), 0)
    return () => window.clearTimeout(timer)
  }, [focusSearchInput])

  // Keep VS Code context keys in sync when filters change locally (e.g., via clear icon)
  useEffect(() => {
    const type = (filter['type'] as any) ?? ''
    // topic only applies to libraries
    const topic = (filter['topic'] as any) ?? ''
    const webviewType = (window as any).__ARDUNNO_WEBVIEW_TYPE__ as
      | 'libraries'
      | 'platforms'
      | string
    try {
      if (webviewType === 'platforms') {
        vscode.messenger?.sendRequest(
          setPlatformsFilterContext,
          HOST_EXTENSION,
          { type }
        )
      } else if (webviewType === 'libraries') {
        vscode.messenger?.sendRequest(
          setLibrariesFilterContext,
          HOST_EXTENSION,
          {
            type,
            // @ts-ignore
            topic,
          }
        )
      }
    } catch (err) {
      console.error('Failed to push filter context', err)
    }
  }, [filter])

  // React to filter changes coming from the extension-side (menu commands)
  useEffect(() => {
    const webviewType = (window as any).__ARDUNNO_WEBVIEW_TYPE__ as
      | 'libraries'
      | 'platforms'
      | string
    if (webviewType === 'platforms') {
      vscode.messenger?.onNotification(
        notifyPlatformsFilterChanged,
        (params) => {
          setFilter((prev) => {
            const next: Record<string, string> = { ...prev }
            if (params.type !== undefined) {
              if (params.type === '') delete next['type']
              else next['type'] = params.type
            }
            return next
          })
        }
      )
    } else {
      vscode.messenger?.onNotification(
        notifyLibrariesFilterChanged,
        (params: any) => {
          setFilter((prev) => {
            const next: Record<string, string> = { ...prev }
            if (params.type !== undefined) {
              if (params.type === '') delete next['type']
              else next['type'] = params.type
            }
            if (params.topic !== undefined) {
              if (params.topic === '') delete next['topic']
              else next['topic'] = params.topic
            }
            return next
          })
        }
      )
    }
  }, [])

  const isFiltered = useMemo(
    () => Object.values(filter).some((v) => v && v !== 'All'),
    [filter]
  )

  const clearFilters = useCallback(() => {
    setFilter({})
    try {
      const webviewType = (window as any).__ARDUNNO_WEBVIEW_TYPE__ as string
      if (webviewType === 'platforms') {
        vscode.messenger?.sendRequest(
          setPlatformsFilterContext,
          HOST_EXTENSION,
          {
            // @ts-ignore
            type: '',
          }
        )
      } else {
        vscode.messenger?.sendRequest(
          setLibrariesFilterContext,
          HOST_EXTENSION,
          {
            // @ts-ignore
            type: '',
            topic: '',
          }
        )
      }
    } catch (err) {
      console.error('Failed to clear filter context', err)
    }
  }, [])

  useEffect(() => {
    if (typeof vscode.setState === 'function') {
      try {
        vscode.setState({ query, filter: { ...filter } })
      } catch (err) {
        console.error('Failed to persist resources state', err)
      }
    }
  }, [query, filter])

  return (
    <div className="search">
      <VscodeTextfield
        value={query}
        placeholder="Search"
        onInput={onInput}
        data-ardunno-search-input
      >
        {isFiltered ? (
          <VscodeIcon
            slot="content-after"
            actionIcon
            name="clear-all"
            title="Clear All Filters"
            aria-label="Clear All Filters"
            onClick={() => clearFilters()}
          />
        ) : null}
        <VscodeIcon
          slot="content-after"
          actionIcon
          name="filter"
          aria-label="Filter..."
          title="Filter..."
          data-vscode-context={createVscodeDataContext({
            webviewSection: 'search-filter',
          })}
          onClick={dispatchContextMenuEvent as any}
        />
      </VscodeTextfield>
    </div>
  )
}

interface ListProps<T extends Resource = Resource> {
  readonly noResults: boolean

  readonly items: T[]
  readonly selectedItem: SelectedItem<T> | undefined
  readonly setSelectedItem: (item: SelectedItem<T>) => void

  readonly busyItems: string[]
  readonly install: (params: { item: T; version: string }) => Promise<void>
  readonly uninstall: (params: { item: T }) => Promise<void>
}

interface SelectedItem<T extends Resource = Resource> {
  readonly item: T | undefined
  readonly version: Version | undefined
}

function noSelectedItem<T extends Resource = Resource>(): SelectedItem<T> {
  return { item: undefined, version: undefined }
}

function List<T extends Resource = Resource>(props: ListProps<T>) {
  const { noResults, items } = props
  const [isTopVisible, setIsTopVisible] = useState<boolean>(true)
  const listBodyRef = useRef<HTMLDivElement | null>(null)
  const [availableHeight, setAvailableHeight] = useState<number | undefined>()

  // https://github.com/petyosi/react-virtuoso/issues/37#issuecomment-528658615
  // Keep the Virtuoso scroller sized with the viewport instead of relying on parent height chains.
  const updateAvailableHeight = useCallback(() => {
    if (typeof window === 'undefined') {
      return
    }
    const element = listBodyRef.current
    if (!element) {
      setAvailableHeight(undefined)
      return
    }
    const { top } = element.getBoundingClientRect()
    const measuredHeight = Math.floor(window.innerHeight - top)
    if (!Number.isFinite(measuredHeight) || measuredHeight <= 0) {
      setAvailableHeight(undefined)
      return
    }
    setAvailableHeight((previous) => {
      if (previous === undefined || Math.abs(previous - measuredHeight) >= 1) {
        return measuredHeight
      }
      return previous
    })
  }, [])

  useLayoutEffect(() => {
    if (noResults) {
      setAvailableHeight(undefined)
      return
    }
    updateAvailableHeight()
  }, [noResults, updateAvailableHeight, items.length])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    const handleResize = () => updateAvailableHeight()
    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
    }
  }, [updateAvailableHeight])

  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      typeof ResizeObserver === 'undefined'
    ) {
      return
    }
    const element = listBodyRef.current?.parentElement
    if (!element) {
      return
    }
    const observer = new ResizeObserver(() => updateAvailableHeight())
    observer.observe(element)
    const root = document.documentElement
    if (root) {
      observer.observe(root)
    }
    return () => {
      observer.disconnect()
    }
  }, [updateAvailableHeight, noResults])
  return (
    // disable the default copy/paste/cut context menu https://code.visualstudio.com/api/extension-guides/webview#context-menus
    <div
      className="list"
      data-vscode-context={JSON.stringify(preventDefaultContextMenuItems)}
    >
      {noResults ? (
        <Info label="No results found" />
      ) : (
        <>
          {!isTopVisible ? <div className="shadow" /> : null}
          <div className="list-body" ref={listBodyRef}>
            <Virtuoso
              style={{ height: availableHeight ?? '100%' }}
              data={items}
              atTopStateChange={setIsTopVisible}
              itemContent={(index, item) => (
                <Item item={item} index={index} {...props} />
              )}
            />
          </div>
        </>
      )}
    </div>
  )
}

function Info(props: { label: string }) {
  const { label } = props
  return <div className="info">{label}</div>
}

interface ItemProps<T extends Resource = Resource> {
  readonly item: T
  readonly index: number

  readonly selectedItem: SelectedItem<T> | undefined
  readonly setSelectedItem: (item: SelectedItem<T>) => void
  readonly busyItems: string[]

  readonly install: (params: { item: T; version: string }) => Promise<void>
  readonly uninstall: (params: { item: T }) => Promise<void>
}

function Item<T extends Resource = Resource>(props: ItemProps<T>) {
  return (
    <>
      <Separator {...props} />
      <div className="item">
        <Header {...props} />
        <Content {...props} />
        <Footer {...props} />
      </div>
    </>
  )
}

function Separator<T extends Resource = Resource>(props: ItemProps<T>) {
  const { index } = props
  return index ? <VscodeDivider role="separator" /> : null
}

function Header<T extends Resource = Resource>(props: ItemProps<T>) {
  return (
    <div className="header">
      <div>
        <Title {...props} />
        <Toolbar {...props} />
      </div>
      <InstalledVersion {...props} />
    </div>
  )
}

function InstalledVersion<T extends Resource = Resource>(props: ItemProps<T>) {
  const { installedVersion } = props.item
  return installedVersion ? (
    <div className="version">
      <VscodeBadge>{`${installedVersion} installed`}</VscodeBadge>
    </div>
  ) : null
}

function Toolbar<T extends Resource = Resource>(props: ItemProps<T>) {
  const { item } = props
  const selectedVersion = getSelectedVersion(props)
  const actions = getAllActions(props)
  const actionsSet = new Set(actions)
  return (
    <div className="toolbar">
      <VscodeIcon
        actionIcon
        name="gear"
        // Help the screen reader
        aria-label="More Actions..."
        data-vscode-context={createVscodeDataContext({
          webviewSection: 'toolbar',
          args: [item, selectedVersion],
          canInstallLatest: actionsSet.has('installLatest'),
          canInstallSelected: actionsSet.has('installSelected'),
          canUpdate: actionsSet.has('update'),
          canRemove: actionsSet.has('remove'),
        })}
        onClick={dispatchContextMenuEvent}
      />
    </div>
  )
}

function Title<T extends Resource = Resource>(props: ItemProps<T>) {
  const unknown = 'Unknown'
  const { name, author } = props.item
  const title = name && author ? `${name} by ${author}` : name || unknown
  return (
    <div className="title" title={title}>
      {name && author ? (
        <>
          <span className="name">{name}</span>{' '}
          <span className="author">{`by ${author}`}</span>
        </>
      ) : name ? (
        <span className="name">{name}</span>
      ) : (
        <span className="name">{unknown}</span>
      )}
    </div>
  )
}

function Content<T extends Resource = Resource>(props: ItemProps<T>) {
  const { summary, description } = props.item
  const content = [summary, description].filter(Boolean).join(' ')
  // TODO: build DOM from content? See ControlledServo
  return (
    <div className="content" title={content}>
      <p>{content}</p>
      <MoreInfo {...props} />
    </div>
  )
}

function MoreInfo<T extends Resource = Resource>(props: ItemProps<T>) {
  const { website } = props.item
  return website ? (
    <a className="vscode-link" href={website} target="_blank" rel="noreferrer">
      More info
    </a>
  ) : null
}

function Footer<T extends Resource = Resource>(props: ItemProps<T>) {
  return (
    <div className="footer">
      <SelectVersion {...props} />
      <ActionButton {...props} />
    </div>
  )
}

type Action =
  | 'installLatest'
  | 'installSelected'
  | 'update'
  | 'remove'
  | 'unknown'

function getDefaultAction<T extends Resource = Resource>(
  params: ItemProps<T>,
  selectedVersion: Version | undefined
): Action {
  const { installedVersion, availableVersions } = params.item
  const latest = availableVersions[0]
  if (
    !latest ||
    (installedVersion && !availableVersions.includes(installedVersion))
  ) {
    return 'unknown'
  }
  const selected = selectedVersion ?? latest
  if (installedVersion === selected) {
    return 'remove'
  }
  if (installedVersion) {
    return selected === latest && installedVersion !== latest
      ? 'update'
      : 'installSelected'
  }
  return selected === latest ? 'installLatest' : 'installSelected'
}

function getAllActions<T extends Resource = Resource>(
  props: ItemProps<T>
): Action[] {
  const selectedVersion = getSelectedVersion(props)
  const installedVersion = props.item.installedVersion
  const action = getDefaultAction(props, selectedVersion)
  switch (action) {
    case 'unknown':
      return []
    case 'remove': {
      return ['remove']
    }
    case 'update': {
      return ['remove', 'update']
    }
    case 'installLatest': {
      const actions: Action[] = ['installLatest']
      if (installedVersion) {
        actions.unshift('remove')
      }
      return actions
    }
    case 'installSelected': {
      const actions: Action[] = ['installSelected']
      if (installedVersion) {
        actions.unshift('remove')
      }
      return actions
    }
  }
}

function getSelectedVersion<T extends Resource = Resource>(
  props: ItemProps<T>
): Version {
  const { item, selectedItem } = props
  const selectedVersion =
    (selectedItem?.item?.id === item.id ? selectedItem.version : undefined) ??
    item.availableVersions[0]
  return selectedVersion
}

function ActionButton<T extends Resource = Resource>(props: ItemProps<T>) {
  const { item, busyItems, install, uninstall } = props
  const selectedVersion = getSelectedVersion(props)
  const defaultAction = getDefaultAction(props, selectedVersion)
  if (defaultAction === 'unknown') {
    return null
  }
  const appearance =
    defaultAction === 'installLatest' || defaultAction === 'update'
      ? 'primary'
      : 'secondary'
  let label = 'Install'
  if (defaultAction === 'remove') {
    label = 'Remove'
  } else if (defaultAction === 'update') {
    label = 'Update'
  }
  let onClick = () => install({ item, version: selectedVersion })
  if (defaultAction === 'installSelected') {
    onClick = () => install({ item, version: selectedVersion })
  } else if (defaultAction === 'remove') {
    onClick = () => uninstall({ item })
  }
  const disabled = Boolean(isBusy(item, busyItems))
  const appearanceProps = { appearance } as Record<string, unknown>
  return (
    <>
      <VscodeButton
        className="action-button"
        disabled={disabled}
        onClick={onClick}
        {...appearanceProps}
      >
        {label}
      </VscodeButton>
      {disabled ? <VscodeProgressRing /> : null}
    </>
  )
}

function isBusy<T extends Resource = Resource>(
  item: T,
  busyItems: string[]
): boolean {
  return busyItems.some((busyItem) => busyItem === item.id)
}

function SelectVersion<T extends Resource = Resource>(props: ItemProps<T>) {
  const { item, selectedItem, busyItems } = props
  const value =
    selectedItem?.item?.id === item.id
      ? selectedItem.version
      : item.availableVersions[0]
  return (
    <VscodeSingleSelect
      value={value}
      onChange={(event: any) => {
        const target = event.target
        if (
          // TODO: replace with an instanceof
          typeof target === 'object' &&
          target !== null &&
          'value' in target &&
          typeof target.value === 'string'
        ) {
          const newValue = target.value
          if (item.availableVersions.includes(newValue)) {
            props.setSelectedItem({ item, version: newValue })
          }
        }
      }}
      disabled={isBusy(item, busyItems)}
    >
      {item.availableVersions.map((version) => (
        <VscodeOption
          key={version}
          value={version}
          selected={version === value}
        >
          {version}
        </VscodeOption>
      ))}
    </VscodeSingleSelect>
  )
}
