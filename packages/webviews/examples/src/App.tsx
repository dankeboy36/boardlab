import {
  Tree,
  useCodiconStylesheet,
  vscode,
  type TreeNode,
} from '@vscode-ardunno/base'
import type {
  Board,
  ExampleLibrary,
  ExampleTreeNode,
} from '@vscode-ardunno/protocol'
import {
  getSelectedBoard,
  listExamples,
  notifyDidChangeSelectedBoard,
  notifyExamplesToolbarAction,
  openExampleReadme,
  openExampleResource as openExampleResourceRequest,
  openExampleSketch as openExampleSketchRequest,
} from '@vscode-ardunno/protocol'
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from 'react'
import { HOST_EXTENSION } from 'vscode-messenger-common'
import {
  VscodeBadge,
  VscodeIcon,
  VscodeScrollable,
  VscodeTextfield,
} from 'vscode-react-elements-x'

import '../../base/styles/tree.css'
import './App.css'

type BucketKey = ExampleLibrary['source']
type GroupedLibraries = Record<BucketKey, ExampleLibrary[]>

type SearchConfig =
  | { mode: 'all' }
  | { mode: 'invalid'; error: string }
  | { mode: 'regex'; regex: RegExp }
  | {
      mode: 'substring' | 'whole'
      tokens: string[]
      caseSensitive: boolean
    }

type ActiveSearchConfig = Exclude<
  SearchConfig,
  { mode: 'all' } | { mode: 'invalid' }
>

const BUCKET_DEFINITIONS: ReadonlyArray<{
  readonly key: BucketKey
  readonly label: string
  readonly emptyLabel: string
}> = [
  {
    key: 'builtin',
    label: 'Built-in Examples',
    emptyLabel: 'No built-in examples available.',
  },
  {
    key: 'platform',
    label: 'Board Libraries',
    emptyLabel: 'No board-specific libraries available.',
  },
  {
    key: 'library',
    label: 'Custom Libraries',
    emptyLabel: 'No custom libraries with examples installed.',
  },
] as const

export function App(): JSX.Element {
  useCodiconStylesheet()

  const initialSearchState = useMemo(() => {
    const persisted =
      (typeof vscode.getState === 'function' ? vscode.getState() : undefined) ??
      (typeof window !== 'undefined'
        ? (window as any).__INITIAL_VSCODE_STATE__
        : undefined)
    if (persisted && typeof persisted === 'object') {
      const state = persisted as Record<string, unknown>
      const getBool = (value: unknown) =>
        typeof value === 'boolean' ? value : undefined
      return {
        query: typeof state.query === 'string' ? state.query : '',
        matchCase: getBool(state.matchCase) ?? false,
        matchWholeWord: getBool(state.matchWholeWord) ?? false,
        useRegex: getBool(state.useRegex) ?? false,
      }
    }
    return {
      query: '',
      matchCase: false,
      matchWholeWord: false,
      useRegex: false,
    }
  }, [])

  const [examples, setExamples] = useState<ExampleLibrary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>(undefined)
  const [selectedBoard, setSelectedBoard] = useState<Board | undefined>()

  const [query, setQuery] = useState(initialSearchState.query)
  const [matchCase, setMatchCase] = useState(initialSearchState.matchCase)
  const [matchWholeWord, setMatchWholeWord] = useState(
    initialSearchState.matchWholeWord
  )
  const [useRegex, setUseRegex] = useState(initialSearchState.useRegex)
  const [regexError, setRegexError] = useState<string | undefined>(undefined)
  const [treeResetKey, setTreeResetKey] = useState(0)
  const [reloadKey, setReloadKey] = useState(0)
  // Actions are shown on hover via CSS; no hover state needed

  useEffect(() => {
    const messenger = vscode.messenger
    if (!messenger) {
      return
    }
    messenger.onNotification(notifyDidChangeSelectedBoard, (board) => {
      setSelectedBoard(board ?? undefined)
    })
  }, [])

  useEffect(() => {
    const messenger = vscode.messenger
    if (!messenger) {
      return
    }

    let disposed = false
    messenger
      .sendRequest(getSelectedBoard, HOST_EXTENSION, undefined)
      .then((board) => {
        if (!disposed) {
          setSelectedBoard(board ?? undefined)
        }
      })
      .catch((err) => {
        console.warn('Failed to resolve initially selected board', err)
      })

    return () => {
      disposed = true
    }
  }, [])

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
      console.error('Failed to focus examples search host', err)
    }
    const input = host.shadowRoot?.querySelector('input')
    if (input instanceof HTMLInputElement) {
      input.focus()
      if (input.value) {
        input.select()
      }
    }
  }, [])

  useEffect(() => {
    const messenger = vscode.messenger
    if (!messenger) {
      setError('Messenger unavailable')
      setLoading(false)
      return
    }

    let disposed = false
    const fetchExamples = async () => {
      setLoading(true)
      try {
        const result = (await messenger.sendRequest(
          listExamples,
          HOST_EXTENSION,
          { fqbn: selectedBoard?.fqbn }
        )) as ExampleLibrary[]
        if (!disposed) {
          setExamples(result ?? [])
          setError(undefined)
        }
      } catch (err) {
        if (!disposed) {
          setError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        if (!disposed) {
          setLoading(false)
        }
      }
    }

    fetchExamples()

    return () => {
      disposed = true
    }
  }, [selectedBoard?.fqbn, reloadKey])

  useEffect(() => {
    const messenger = vscode.messenger
    if (!messenger) {
      return
    }
    messenger.onNotification(notifyExamplesToolbarAction, ({ action }) => {
      if (action === 'refresh') {
        setQuery('')
        setMatchCase(false)
        setMatchWholeWord(false)
        setUseRegex(false)
        setRegexError(undefined)
        setTreeResetKey((key) => key + 1)
        setReloadKey((key) => key + 1)
        focusSearchInput()
      }
    })
  }, [focusSearchInput])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    const timer = window.setTimeout(() => focusSearchInput(), 0)
    return () => window.clearTimeout(timer)
  }, [focusSearchInput, reloadKey])

  const searchConfig = useMemo<SearchConfig>(() => {
    const trimmed = query.trim()
    if (!trimmed.length) {
      return { mode: 'all' }
    }
    if (useRegex) {
      try {
        const regex = new RegExp(trimmed, matchCase ? '' : 'i')
        return { mode: 'regex', regex }
      } catch (err) {
        return {
          mode: 'invalid',
          error: err instanceof Error ? err.message : String(err),
        }
      }
    }
    const tokens = trimmed.split(/\s+/).filter(Boolean)
    const processedTokens = matchCase
      ? tokens
      : tokens.map((token) => token.toLowerCase())
    return {
      mode: matchWholeWord ? 'whole' : 'substring',
      tokens: processedTokens,
      caseSensitive: matchCase,
    }
  }, [query, matchCase, matchWholeWord, useRegex])

  useEffect(() => {
    if (searchConfig.mode === 'invalid') {
      setRegexError(searchConfig.error)
    } else {
      setRegexError(undefined)
    }
  }, [searchConfig])

  const filteredExamples = useMemo(() => {
    if (searchConfig.mode === 'all' || searchConfig.mode === 'invalid') {
      return examples
    }
    const activeConfig = searchConfig as ActiveSearchConfig
    return examples.reduce<ExampleLibrary[]>((acc, library) => {
      const libraryMatches = matchesSearchConfig(activeConfig, library.label)
      const filteredNodes = filterLibraryNodes(library, activeConfig)
      if (libraryMatches) {
        acc.push(library)
        return acc
      }
      if (filteredNodes.length) {
        acc.push({
          ...library,
          nodes: filteredNodes,
        })
      }
      return acc
    }, [])
  }, [examples, searchConfig])

  const grouped = useMemo<GroupedLibraries>(() => {
    return filteredExamples.reduce<GroupedLibraries>(
      (acc, library) => {
        acc[library.source].push(library)
        return acc
      },
      { builtin: [], platform: [], library: [] }
    )
  }, [filteredExamples])

  const openReadme = useCallback(async (exampleId: string) => {
    const messenger = vscode.messenger
    if (!messenger) {
      console.warn('Messenger unavailable; cannot open README.')
      return
    }
    try {
      await messenger.sendRequest(openExampleReadme, HOST_EXTENSION, {
        exampleId,
      })
    } catch (err) {
      console.error('Failed to open README', err)
    }
  }, [])

  const openExampleSketch = useCallback(
    async (exampleId: string, relPath: string) => {
      const messenger = vscode.messenger
      if (!messenger) {
        console.warn('Messenger unavailable; cannot open example sketch.')
        return
      }
      try {
        await messenger.sendRequest(openExampleSketchRequest, HOST_EXTENSION, {
          exampleId,
          sketchRelPath: relPath,
        })
      } catch (err) {
        console.error('Failed to open example sketch', err)
      }
    },
    []
  )

  const openResource = useCallback(
    async (exampleId: string, relPath: string) => {
      const messenger = vscode.messenger
      if (!messenger) {
        console.warn('Messenger unavailable; cannot open example resource.')
        return
      }
      try {
        await messenger.sendRequest(
          openExampleResourceRequest,
          HOST_EXTENSION,
          {
            exampleId,
            resourceRelPath: relPath,
          }
        )
      } catch (err) {
        console.error('Failed to open example resource', err)
      }
    },
    []
  )

  // no-op

  const hasExamples = examples.length > 0
  const hasResults = filteredExamples.length > 0
  const isFiltering =
    searchConfig.mode !== 'all' && searchConfig.mode !== 'invalid'

  const status = useMemo(() => {
    if (loading) {
      return { text: 'Loading examples…', tone: 'info' as const }
    }
    if (error) {
      return {
        text: `Failed to load examples: ${error}`,
        tone: 'error' as const,
      }
    }
    if (!hasExamples) {
      return { text: 'No examples found.', tone: 'info' as const }
    }
    if (isFiltering && !hasResults) {
      return {
        text: 'No examples match the current search.',
        tone: 'info' as const,
      }
    }
    return undefined
  }, [loading, error, hasExamples, isFiltering, hasResults])

  const handleQueryChange = useCallback(
    (event: FormEvent<HTMLInputElement>) => {
      setQuery(event.currentTarget.value)
    },
    []
  )

  const toggleMatchCase = useCallback(() => {
    setMatchCase((prev) => !prev)
  }, [])

  const toggleMatchWholeWord = useCallback(() => {
    setMatchWholeWord((prev) => !prev)
  }, [])

  const toggleRegex = useCallback(() => {
    setUseRegex((prev) => !prev)
  }, [])

  const statusClassName =
    status?.tone === 'error'
      ? 'examples-view__status examples-view__status--error'
      : 'examples-view__status'

  useEffect(() => {
    if (typeof vscode.setState === 'function') {
      try {
        vscode.setState({
          query,
          matchCase,
          matchWholeWord,
          useRegex,
        })
      } catch (err) {
        console.error('Failed to persist examples search state', err)
      }
    }
  }, [query, matchCase, matchWholeWord, useRegex])

  return (
    <div className="examples-view">
      <div className="examples-view__search">
        <VscodeTextfield
          aria-label="Filter examples"
          placeholder="Filter examples"
          type="text"
          value={query}
          onInput={handleQueryChange}
          invalid={Boolean(regexError)}
          data-ardunno-search-input
        >
          <VscodeIcon
            slot="content-after"
            actionIcon
            name="case-sensitive"
            title="Match Case"
            aria-label="Match Case"
            className="examples-search__icon"
            data-active={matchCase ? 'true' : undefined}
            onClick={toggleMatchCase}
          />
          <VscodeIcon
            slot="content-after"
            actionIcon
            name="whole-word"
            title="Match Whole Word"
            aria-label="Match Whole Word"
            className="examples-search__icon"
            data-active={matchWholeWord ? 'true' : undefined}
            onClick={toggleMatchWholeWord}
          />
          <VscodeIcon
            slot="content-after"
            actionIcon
            name="regex"
            title="Use Regular Expression"
            aria-label="Use Regular Expression"
            className="examples-search__icon"
            data-active={useRegex ? 'true' : undefined}
            onClick={toggleRegex}
          />
        </VscodeTextfield>
        {regexError ? (
          <div className="examples-view__search-error">{regexError}</div>
        ) : null}
      </div>
      <div className="examples-view__body">
        {status ? (
          <div className={statusClassName}>{status.text}</div>
        ) : (
          <VscodeScrollable className="examples-view__tree-container">
            <Tree
              key={treeResetKey}
              className="examples-tree tree--actions-on-hover"
              expandMode="singleClick"
              multiSelect={false}
              ariaLabel="Arduino examples"
              items={buildTreeItems(
                grouped,
                openReadme,
                openExampleSketch,
                openResource
              )}
            />
          </VscodeScrollable>
        )}
      </div>
    </div>
  )
}

function countSketchNodes(nodes: readonly ExampleTreeNode[]): number {
  let count = 0
  for (const node of nodes) {
    if (node.kind === 'sketch') {
      count += 1
    }
    if (node.kind === 'folder' || node.kind === 'sketch') {
      count += countSketchNodes(node.children)
    }
  }
  return count
}

function filterLibraryNodes(
  library: ExampleLibrary,
  config: ActiveSearchConfig
): ExampleTreeNode[] {
  return library.nodes
    .map((node) => filterNode(library, node, config))
    .filter((node): node is ExampleTreeNode => Boolean(node))
}

function filterNode(
  library: ExampleLibrary,
  node: ExampleTreeNode,
  config: ActiveSearchConfig
): ExampleTreeNode | undefined {
  const path = buildNodePath(library.label, node)
  const matched = matchesSearchConfig(config, path)

  if (node.kind === 'resource') {
    return matched ? node : undefined
  }

  const filteredChildren = node.children
    .map((child) => filterNode(library, child, config))
    .filter((child): child is ExampleTreeNode => Boolean(child))

  if (matched) {
    if (filteredChildren.length) {
      return { ...node, children: filteredChildren }
    }
    return node
  }

  if (filteredChildren.length) {
    return { ...node, children: filteredChildren }
  }

  return undefined
}

function matchesSearchConfig(
  config: ActiveSearchConfig,
  text: string
): boolean {
  switch (config.mode) {
    case 'regex':
      return config.regex.test(text)
    case 'substring': {
      const target = config.caseSensitive ? text : text.toLowerCase()
      return config.tokens.every((token) => target.includes(token))
    }
    case 'whole': {
      const segments = text.split(/[\\/._\s-]+/).filter(Boolean)
      const normalized = config.caseSensitive
        ? segments
        : segments.map((segment) => segment.toLowerCase())
      return config.tokens.every((token) =>
        normalized.some((segment) => segment === token)
      )
    }
    default:
      return false
  }
}

function buildNodePath(label: string, node: ExampleTreeNode): string {
  if (node.relPath && node.relPath.length) {
    return `${label}/${node.relPath}`
  }
  return `${label}/${node.name}`
}

function buildTreeItems(
  grouped: GroupedLibraries,
  onPreviewLibrary: (exampleId: string) => void,
  onPreviewSketch: (exampleId: string, relPath: string) => void,
  onOpenResource: (exampleId: string, relPath: string) => void
): TreeNode[] {
  const toResourceNode = (
    example: ExampleLibrary,
    node: ExampleTreeNode
  ): TreeNode => {
    return {
      id: node.relPath || `${example.id}:${node.name}`,
      label: node.name,
      dataAttrs: { kind: 'resource' },
      onClick: (ev) => {
        ev.preventDefault()
        ev.stopPropagation()
        onOpenResource(example.id, node.relPath!)
      },
    }
  }

  const toSketchNode = (
    example: ExampleLibrary,
    node: ExampleTreeNode,
    depth: number,
    flattenBuiltinRoot: boolean
  ): TreeNode => {
    const actions =
      example.source === 'builtin'
        ? [
            {
              icon: 'file-code',
              ariaLabel: 'Preview built-in example',
              title: 'Preview built-in example',
              onClick: (ev: any) => {
                onPreviewSketch(example.id, node.relPath!)
              },
            },
          ]
        : undefined

    return {
      id: node.relPath || `${example.id}:${node.name}`,
      label: node.name,
      dataAttrs: { kind: 'sketch' },
      branch: node.children.length > 0,
      actions,
      children: node.children.map((child) =>
        toTreeNode(example, child, depth + 1, flattenBuiltinRoot)
      ),
    }
  }

  const toFolderNode = (
    example: ExampleLibrary,
    node: ExampleTreeNode,
    depth: number,
    flattenBuiltinRoot: boolean
  ): TreeNode => {
    const folderCount =
      flattenBuiltinRoot && depth === 1
        ? countSketchNodes(node.children)
        : undefined
    return {
      id: node.relPath || `${example.id}:${node.name}`,
      label: node.name,
      dataAttrs: { kind: 'folder' },
      branch: node.children.length > 0,
      decoration:
        folderCount && folderCount > 0 ? (
          <VscodeBadge variant="counter">{folderCount}</VscodeBadge>
        ) : undefined,
      children: node.children.map((child) =>
        toTreeNode(example, child, depth + 1, flattenBuiltinRoot)
      ),
    }
  }

  const toTreeNode = (
    example: ExampleLibrary,
    node: ExampleTreeNode,
    depth: number,
    flattenBuiltinRoot: boolean
  ): TreeNode => {
    if (node.kind === 'resource') {
      return toResourceNode(example, node)
    }
    if (node.kind === 'sketch') {
      return toSketchNode(example, node, depth, flattenBuiltinRoot)
    }
    return toFolderNode(example, node, depth, flattenBuiltinRoot)
  }

  const toLibraryNode = (example: ExampleLibrary): TreeNode => {
    const count = countSketchNodes(example.nodes)
    const actions = [
      {
        icon: 'file-code',
        ariaLabel: 'Preview example',
        title: 'Preview example',
        onClick: () => onPreviewLibrary(example.id),
      },
    ]
    return {
      id: example.id,
      label: example.label,
      className: 'examples-tree__library',
      dataAttrs: { 'example-id': example.id },
      branch: example.nodes.length > 0,
      decoration: count ? (
        <VscodeBadge variant="counter">{count}</VscodeBadge>
      ) : undefined,
      actions,
      children: example.nodes.map((node) =>
        toTreeNode(example, node, 1, false)
      ),
    }
  }

  const items: TreeNode[] = []
  for (const bucket of BUCKET_DEFINITIONS) {
    const entries = grouped[bucket.key]
    const flattenBuiltin =
      bucket.key === 'builtin' &&
      entries.length === 1 &&
      entries[0]?.label === bucket.label
    const bucketCount = flattenBuiltin
      ? (entries[0]?.nodes.length ?? 0)
      : entries.length

    const children: TreeNode[] =
      bucketCount === 0
        ? [
            {
              id: `${bucket.key}-empty`,
              className: 'examples-tree__placeholder',
              dataAttrs: { placeholder: true },
              label: (
                <span className="message">
                  <span className="message-raw">{bucket.emptyLabel}</span>
                </span>
              ),
            },
          ]
        : flattenBuiltin && entries[0]
          ? entries[0].nodes.map((node) =>
              toTreeNode(entries[0]!, node, 1, true)
            )
          : entries.map((example) => toLibraryNode(example))

    items.push({
      id: bucket.key,
      className: 'examples-tree__bucket',
      dataAttrs: { source: bucket.key },
      label: bucket.label,
      branch: true,
      open: true,
      decoration: <VscodeBadge variant="counter">{bucketCount}</VscodeBadge>,
      children,
    })
  }

  return items
}
