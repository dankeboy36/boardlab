import { createPortKey, type DetectedPorts } from 'boards-list'
import { FQBN, valid as isValidFQBN } from 'fqbn'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { HOST_EXTENSION } from 'vscode-messenger-common'
import type { Messenger } from 'vscode-messenger-webview'
import {
  VscodeBadge,
  VscodeButton,
  VscodeButtonGroup,
  VscodeContextMenu,
  VscodeIcon,
  VscodeLabel,
  VscodeScrollable,
  VscodeSplitLayout,
  VscodeTextarea,
  VscodeTextfield,
} from 'vscode-react-elements-x'

import {
  createVscodeDataContext,
  dispatchContextMenuEvent,
  messengerx,
  preventDefaultContextMenuItems,
  Tree,
  useCodiconStylesheet,
  vscode,
  type TreeNode,
} from '@boardlab/base'
import {
  BoardDescriptor,
  createProfile,
  listProfiles,
  notifyProfilesActiveProfileChanged,
  notifyProfilesChanged,
  notifyProfilesDetectedPortsChanged,
  pickBoardForCreation,
  profilesAddPortConfig,
  profilesApplyQuickFixById,
  ProfilesDocumentState,
  profilesGetActiveProfile,
  profilesListDiagnostics,
  profilesListQuickFixes,
  profilesPickBoard,
  profilesPickBoardConfigOptionForCreation,
  profilesPickLibrary,
  profilesPickLibraryForCreation,
  profilesPickLibraryVersion,
  profilesPickLibraryVersionForCreation,
  profilesPickPlatform,
  profilesPickPlatformForCreation,
  profilesPickPlatformIndexUrl,
  profilesPickPlatformVersion,
  profilesPickPlatformVersionForCreation,
  profilesPickPortConfigForCreation,
  profilesPickPortConfigValue,
  profilesPickPortConfigValueForCreation,
  profilesPickPortForCreation,
  profilesPickProgrammerForCreation,
  profilesRemovePortConfig,
  profilesRenameProfile,
  profilesRequestDetectedPorts,
  profilesResetBoardConfigOption,
  profilesResetBoardConfigOptionForCreation,
  profilesResolveBoardDetails,
  profilesResolvePlatformName,
  profilesResolvePortConfigLabels,
  profilesRevealRange,
  profilesSelectBoardConfigOption,
  profilesSelectPort,
  profilesSelectProgrammer,
  profilesSetActiveProfile,
  removeLibrary,
  removePlatform,
  updateProfile,
  type ProfileLibraryDescriptor,
  type ProfilePlatformDescriptor,
} from '@boardlab/protocol'

import '../../base/styles/tree.css'
import './App.css'

interface PersistedState {
  readonly activeProfile?: string
}

interface BootstrapState {
  readonly uri: string
  readonly snapshot?: ProfilesDocumentState
  readonly persisted?: PersistedState
}

const DRAFT_PROFILE_KEY = '__draft__'

interface DraftProfile {
  name: string
  fqbn: string
  platforms: ProfilePlatformDescriptor[]
  libraries: ProfileLibraryDescriptor[]
  boardDescriptor?: BoardDescriptor
  programmer?: string
  port?: string
  protocol?: string
  portConfig?: Record<string, string | number | boolean>
  note?: string
}

function readBootstrap(): BootstrapState {
  const initial =
    typeof window !== 'undefined'
      ? (
          window as typeof window & {
            __INITIAL_VSCODE_STATE__?: BootstrapState
          }
        ).__INITIAL_VSCODE_STATE__
      : undefined
  const persisted =
    typeof vscode.getState === 'function'
      ? (vscode.getState() as unknown)
      : undefined
  return {
    uri: initial?.uri ?? '',
    snapshot: initial?.snapshot,
    persisted:
      persisted && typeof persisted === 'object'
        ? (persisted as PersistedState)
        : undefined,
  }
}

const EMPTY_STATE: ProfilesDocumentState = {
  profiles: [],
  selectedProfile: undefined,
  hasDocument: false,
}

type NameSectionProps = {
  value: string
  placeholder?: string
  inputRef?: any
  onChange: (next: string) => void
  onCommit?: (next: string) => void | Promise<void>
}

function ProfileNameSection({
  value,
  placeholder = 'Profile name',
  inputRef,
  onChange,
  onCommit,
}: NameSectionProps): JSX.Element {
  const commit = useCallback(
    (next: string) => {
      const trimmed = (next ?? '').trim()
      if (!onCommit) return
      if (trimmed === (value ?? '')) return
      try {
        const result = onCommit(trimmed)
        if (result && typeof (result as any).catch === 'function') {
          ;(result as any).catch(() => {})
        }
      } catch {}
    },
    [onCommit, value]
  )
  return (
    <section className="profiles-editor__section">
      <header className="profiles-editor__section-header">
        <VscodeLabel>Name</VscodeLabel>
      </header>
      <VscodeTextfield
        ref={inputRef}
        value={value}
        placeholder={placeholder}
        onInput={(event: any) => onChange(event.target.value ?? '')}
        onKeyDown={(event: any) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            event.currentTarget.blur()
          }
        }}
        onBlur={(event: any) => commit(String(event.target.value ?? ''))}
      />
    </section>
  )
}

type NoteSectionProps = {
  value: string
  placeholder?: string
  rows?: number
  onChange: (next: string) => void
  onCommit?: (next: string) => void | Promise<void>
}

function NoteSection({
  value,
  placeholder = 'Add note',
  rows = 4,
  onChange,
  onCommit,
}: NoteSectionProps): JSX.Element {
  const commit = useCallback(
    (next: string) => {
      const trimmed = (next ?? '').toString()
      if (!onCommit) return
      try {
        const result = onCommit(trimmed)
        if (result && typeof (result as any).catch === 'function') {
          ;(result as any).catch(() => {})
        }
      } catch {}
    },
    [onCommit]
  )
  return (
    <section className="profiles-editor__section">
      <VscodeTextarea
        rows={rows}
        resize="vertical"
        value={value}
        placeholder={placeholder}
        onInput={(e: any) => onChange(e.target?.value ?? '')}
        onBlur={(e: any) => commit(String(e.target?.value ?? ''))}
      />
    </section>
  )
}

export function App(): JSX.Element {
  useCodiconStylesheet()

  const bootstrap = useMemo(() => readBootstrap(), [])
  const documentUri = bootstrap.uri
  const [state, setState] = useState<ProfilesDocumentState>(
    bootstrap.snapshot ?? EMPTY_STATE
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [boardDetails, setBoardDetails] = useState<BoardDescriptor | undefined>(
    undefined
  )
  const [boardDetailsLoading, setBoardDetailsLoading] = useState(false)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [boardDetailsError, setBoardDetailsError] = useState<
    string | undefined
  >(undefined)
  const [profileDiagnostics, setProfileDiagnostics] = useState<
    ReadonlyArray<{
      message: string
      severity: 'error' | 'warning' | 'information' | 'hint'
      range?: {
        start: { line: number; character: number }
        end: { line: number; character: number }
      }
    }>
  >([])
  const [profileDiagnosticsLoading, setProfileDiagnosticsLoading] =
    useState(false)
  // Cache resolved board details per FQBN for the lifetime of the webview
  const boardDetailsCacheRef = useRef<Map<string, BoardDescriptor>>(new Map())
  const [quickFixMenu, setQuickFixMenu] = useState<{
    show: boolean
    x: number
    y: number
    items: { label: string; value: string }[]
    context?: { uri: string }
  }>({ show: false, x: 0, y: 0, items: [] })

  const initialSelectedProfile = useMemo(() => {
    const available = bootstrap.snapshot?.profiles ?? []
    const persisted = bootstrap.persisted?.activeProfile
    if (persisted && available.some((profile) => profile.name === persisted)) {
      return persisted
    }
    const defaultProfile = bootstrap.snapshot?.selectedProfile
    if (
      defaultProfile &&
      available.some((profile) => profile.name === defaultProfile)
    ) {
      return defaultProfile
    }
    return available[0]?.name
  }, [bootstrap.persisted?.activeProfile, bootstrap.snapshot])

  const [selectedProfileKey, setSelectedProfileKey] = useState<
    string | undefined
  >(initialSelectedProfile)
  const [draftProfile, setDraftProfile] = useState<DraftProfile | undefined>()
  const [draftJustCreated, setDraftJustCreated] = useState(false)
  const draftNameInputRef = useRef<any>(null)
  const [draftValidationError, setDraftValidationError] = useState<
    string | undefined
  >(undefined)
  const [selectedDetailsItem, setSelectedDetailsItem] = useState<
    string | undefined
  >(undefined)
  const [pendingProfileName, setPendingProfileName] = useState<
    string | undefined
  >(undefined)
  const [detectedPorts, setDetectedPorts] = useState<DetectedPorts | undefined>(
    undefined
  )
  const [platformNames, setPlatformNames] = useState<Record<string, string>>({})
  const [unresolvedPlatforms, setUnresolvedPlatforms] = useState<
    Record<string, true>
  >({})
  const [portConfigLabels, setPortConfigLabels] = useState<
    Record<string, string>
  >({})
  const [activeProfileName, setActiveProfileName] = useState<
    string | undefined
  >(undefined)
  const [pendingNote, setPendingNote] = useState<string>('')

  const refocusDetailsTree = useCallback(() => {
    // One-shot: let DOM render, then focus selected item or tree root.
    window.setTimeout(() => {
      try {
        const selected = document.querySelector(
          'vscode-tree.profiles-details-tree vscode-tree-item[selected]'
        ) as HTMLElement | null
        if (selected) {
          try {
            selected.scrollIntoView({ block: 'nearest' })
          } catch {}
          selected.focus()
          return
        }
        const treeEl = document.querySelector(
          'vscode-tree.profiles-details-tree'
        ) as HTMLElement | null
        treeEl?.focus?.()
      } catch {}
    }, 0)
  }, [])

  // No per-item activation here; selection is driven by `selectedDetailsItem`
  // and Tree ensures focus/active state on focus.

  const execute = useCallback(
    async (
      action: (messenger: Messenger) => Promise<ProfilesDocumentState | void>,
      options?: { suppressBusy?: boolean; refocus?: boolean }
    ): Promise<ProfilesDocumentState | undefined> => {
      const messenger = vscode.messenger as Messenger | undefined
      if (!messenger) {
        setError('Profiles API is unavailable in this context.')
        return undefined
      }
      if (!options?.suppressBusy) {
        setBusy(true)
      }
      setError(undefined)
      let result: ProfilesDocumentState | undefined
      try {
        result = (await action(messenger)) as ProfilesDocumentState | undefined
        if (result) {
          setState(result)
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error('Profiles operation failed', err)
        setError(message)
      } finally {
        if (!options?.suppressBusy) {
          setBusy(false)
        }
        // Restore focus to the details tree selection after interactive pickers
        if (options?.refocus !== false) {
          setTimeout(refocusDetailsTree, 0)
        }
      }
      return result
    },
    [refocusDetailsTree]
  )

  useEffect(() => {
    const messenger = vscode.messenger as Messenger | undefined
    if (!messenger || !documentUri) {
      return
    }

    const disposable = messengerx.onNotification(
      messenger,
      notifyProfilesChanged,
      (payload) => {
        if (payload) {
          setState(payload)
          // refresh diagnostics for current selection
          const name =
            selectedProfileKey && selectedProfileKey !== DRAFT_PROFILE_KEY
              ? selectedProfileKey
              : undefined
          if (name) {
            try {
              messenger
                .sendRequest(profilesListDiagnostics, HOST_EXTENSION, {
                  uri: documentUri,
                  profile: name,
                })
                .then((list) => setProfileDiagnostics(list || []))
                .catch(() => setProfileDiagnostics([]))
            } catch {}
          }
        }
      }
    )

    messenger
      .sendRequest(listProfiles, HOST_EXTENSION, { uri: documentUri })
      .then((result) => {
        if (result) {
          setState(result)
        }
      })
      .catch((err) => {
        console.error('Failed to load profiles', err)
        setError(err instanceof Error ? err.message : String(err))
      })

    return () => {
      disposable.dispose()
    }
  }, [documentUri])

  // Subscribe to active profile updates for this document and fetch initial value
  useEffect(() => {
    const messenger = vscode.messenger as Messenger | undefined
    if (!messenger || !documentUri) return

    const disposable = messengerx.onNotification(
      messenger,
      notifyProfilesActiveProfileChanged,
      ({ uri, name }) => {
        if (uri === documentUri) setActiveProfileName(name)
      }
    )
    messenger
      .sendRequest(profilesGetActiveProfile, HOST_EXTENSION, {
        uri: documentUri,
      })
      .then((name) => setActiveProfileName(name))
      .catch((err) => console.warn('Failed to get active profile', err))

    return () => {
      disposable.dispose()
    }
  }, [documentUri])

  // Subscribe to detected ports updates and fetch initial snapshot via BoardLabContext (no monitor connection)
  useEffect(() => {
    const messenger = vscode.messenger as Messenger | undefined
    if (!messenger) return
    const disposable = messengerx.onNotification(
      messenger,
      notifyProfilesDetectedPortsChanged,
      (ports) => setDetectedPorts(ports)
    )
    messenger
      .sendRequest(profilesRequestDetectedPorts, HOST_EXTENSION, undefined)
      .then((ports) => setDetectedPorts(ports))
      .catch((err) =>
        console.warn('Profiles: request detected ports failed', err)
      )

    return () => {
      disposable.dispose()
    }
  }, [])

  useEffect(() => {
    const availableNames = state.profiles.map((profile) => profile.name)

    if (selectedProfileKey === DRAFT_PROFILE_KEY && !draftProfile) {
      const fallback =
        state.selectedProfile ?? state.profiles[0]?.name ?? undefined
      if (fallback !== undefined && fallback !== selectedProfileKey) {
        setSelectedProfileKey(fallback)
      } else if (!fallback) {
        setSelectedProfileKey(undefined)
      }
      return
    }

    if (
      selectedProfileKey &&
      selectedProfileKey !== DRAFT_PROFILE_KEY &&
      !availableNames.includes(selectedProfileKey)
    ) {
      const fallback =
        state.selectedProfile ??
        state.profiles[0]?.name ??
        (draftProfile ? DRAFT_PROFILE_KEY : undefined)
      if (fallback !== selectedProfileKey) {
        setSelectedProfileKey(fallback)
      }
      return
    }

    if (!selectedProfileKey) {
      const fallback =
        state.selectedProfile ??
        state.profiles[0]?.name ??
        (draftProfile ? DRAFT_PROFILE_KEY : undefined)
      if (fallback) {
        setSelectedProfileKey(fallback)
      }
    }
  }, [draftProfile, selectedProfileKey, state.profiles, state.selectedProfile])

  useEffect(() => {
    if (typeof vscode.setState === 'function') {
      try {
        vscode.setState({
          activeProfile:
            selectedProfileKey && selectedProfileKey !== DRAFT_PROFILE_KEY
              ? selectedProfileKey
              : undefined,
        } satisfies PersistedState)
      } catch (err) {
        console.error('Failed to persist profiles editor state', err)
      }
    }
  }, [selectedProfileKey])

  const selectedProfile = useMemo(() => {
    if (!selectedProfileKey || selectedProfileKey === DRAFT_PROFILE_KEY) {
      return undefined
    }
    return state.profiles.find((profile) => profile.name === selectedProfileKey)
  }, [state.profiles, selectedProfileKey])

  // Load diagnostics for selected profile
  useEffect(() => {
    const messenger = vscode.messenger as Messenger | undefined
    if (!messenger || !documentUri) return
    const name =
      selectedProfileKey && selectedProfileKey !== DRAFT_PROFILE_KEY
        ? selectedProfileKey
        : undefined
    if (!name) {
      setProfileDiagnostics([])
      setProfileDiagnosticsLoading(false)
      return
    }
    let disposed = false
    setProfileDiagnosticsLoading(true)
    messenger
      .sendRequest(profilesListDiagnostics, HOST_EXTENSION, {
        uri: documentUri,
        profile: name,
      })
      .then((list) => {
        if (disposed) return
        setProfileDiagnostics(list || [])
        setProfileDiagnosticsLoading(false)
      })
      .catch(() => {
        if (disposed) return
        setProfileDiagnostics([])
        setProfileDiagnosticsLoading(false)
      })
    return () => {
      disposed = true
    }
  }, [selectedProfileKey, documentUri])

  // Keep pending name in sync with selection
  useEffect(() => {
    setPendingProfileName(selectedProfile?.name)
  }, [selectedProfile?.name])

  useEffect(() => {
    setPendingNote(selectedProfile?.note ?? '')
  }, [selectedProfile?.note])

  // Resolve platform display names for selected profile's platforms
  useEffect(() => {
    const messenger = vscode.messenger as Messenger | undefined
    if (!messenger) return
    const ids = new Set(
      (selectedProfile?.platforms || []).map((p) => p.platform)
    )
    const missing = Array.from(ids).filter(
      (id) => !platformNames[id] && !unresolvedPlatforms[id]
    )
    if (!missing.length) return
    let disposed = false
    Promise.all(
      missing.map((id) =>
        messenger
          .sendRequest(profilesResolvePlatformName, HOST_EXTENSION, {
            uri: documentUri,
            platform: id,
          })
          .then((info) => ({ id, name: info?.name }))
          .catch(() => ({ id, name: undefined }))
      )
    ).then((entries) => {
      if (disposed) return
      const namesUpdate: Record<string, string> = {}
      const unresolvedUpdate: Record<string, true> = {}
      for (const { id, name } of entries) {
        if (name) namesUpdate[id] = name
        else unresolvedUpdate[id] = true
      }
      if (Object.keys(namesUpdate).length) {
        setPlatformNames((prev) => ({ ...prev, ...namesUpdate }))
      }
      if (Object.keys(unresolvedUpdate).length) {
        setUnresolvedPlatforms((prev) => ({ ...prev, ...unresolvedUpdate }))
      }
    })
    return () => {
      disposed = true
    }
  }, [
    selectedProfile?.platforms,
    documentUri,
    platformNames,
    unresolvedPlatforms,
  ])

  // Resolve port config labels for selected profile
  useEffect(() => {
    const messenger = vscode.messenger
    if (!messenger || !selectedProfile?.name) return

    messenger
      .sendRequest(profilesResolvePortConfigLabels, HOST_EXTENSION, {
        uri: documentUri,
        profile: selectedProfile.name,
      })
      .then((labels) => setPortConfigLabels(labels))
      .catch(() => setPortConfigLabels({}))
  }, [selectedProfile?.name, documentUri])

  // Track additions to platforms/libraries to select and reveal
  const prevKeysRef = useMemo(
    () => ({
      libs: new Set<string>(),
      plats: new Set<string>(),
      profile: undefined as undefined | string,
    }),
    []
  )
  useEffect(() => {
    const profileName = selectedProfile?.name
    if (!selectedProfile || !profileName) {
      prevKeysRef.libs.clear()
      prevKeysRef.plats.clear()
      prevKeysRef.profile = undefined
      setSelectedDetailsItem(undefined)
      return
    }
    const libKeys = new Set(
      (selectedProfile.libraries || []).map(
        (l) => `library:${l.library}${l.version ? `@${l.version}` : ''}`
      )
    )
    const platKeys = new Set(
      (selectedProfile.platforms || []).map(
        (p) => `platform:${p.platform}${p.version ? `@${p.version}` : ''}`
      )
    )

    // Reset trackers when switching profiles
    if (prevKeysRef.profile !== profileName) {
      prevKeysRef.libs = new Set(libKeys)
      prevKeysRef.plats = new Set(platKeys)
      prevKeysRef.profile = profileName
      setSelectedDetailsItem(undefined)
      return
    }

    // Detect additions
    if (libKeys.size > prevKeysRef.libs.size) {
      for (const k of libKeys) {
        if (!prevKeysRef.libs.has(k)) {
          setSelectedDetailsItem(k)
          break
        }
      }
    } else if (platKeys.size > prevKeysRef.plats.size) {
      for (const k of platKeys) {
        if (!prevKeysRef.plats.has(k)) {
          setSelectedDetailsItem(k)
          break
        }
      }
    }

    // Update previous sets
    prevKeysRef.libs = new Set(libKeys)
    prevKeysRef.plats = new Set(platKeys)
  }, [selectedProfile, prevKeysRef])

  // Reveal selected item in the tree
  useEffect(() => {
    if (!selectedDetailsItem) return
    const el = document.querySelector(
      `vscode-tree-item[data-profile-item="${selectedDetailsItem}"]`
    ) as HTMLElement | null
    if (el) {
      try {
        el.scrollIntoView({ block: 'nearest' })
        el.focus()
      } catch {}
    }
  }, [selectedDetailsItem])

  const isDraftSelected = selectedProfileKey === DRAFT_PROFILE_KEY

  useEffect(() => {
    const messenger = vscode.messenger as Messenger | undefined
    // Reset state when API is not available or no active profile/FQBN
    if (!messenger) {
      setBoardDetails(undefined)
      setBoardDetailsError(undefined)
      setBoardDetailsLoading(false)
      return
    }
    if (!selectedProfile || !selectedProfile.fqbn) {
      setBoardDetails(undefined)
      setBoardDetailsError(undefined)
      setBoardDetailsLoading(false)
      return
    }
    // If FQBN is invalid, do not attempt resolving; just stop loading
    const parsed = isValidFQBN(selectedProfile.fqbn)
    if (!parsed) {
      setBoardDetails(undefined)
      setBoardDetailsError(undefined)
      setBoardDetailsLoading(false)
      return
    }
    let disposed = false
    setBoardDetailsError(undefined)

    // Use base FQBN (vendor:arch:boardId) as cache key
    const baseKey = parsed.toString(true)
    const cached = boardDetailsCacheRef.current.get(baseKey)
    if (cached) {
      // Show cached immediately to avoid UI flicker, but still refresh below
      setBoardDetails(cached)
    }
    // Decide whether to clear previous details. Keep if same base board.
    const prevBase = boardDetails
      ? (() => {
          try {
            return new FQBN(boardDetails.fqbn).toString(true)
          } catch {
            return undefined
          }
        })()
      : undefined
    const sameBase = prevBase === baseKey
    if (!sameBase && !cached) {
      setBoardDetails(undefined)
    }
    // Only show loading when switching base board; avoid loading state on same base to prevent flicker
    const useLoading = !sameBase && !cached
    if (useLoading) setBoardDetailsLoading(true)
    messenger
      .sendRequest(profilesResolveBoardDetails, HOST_EXTENSION, {
        uri: documentUri,
        profile: selectedProfile.name,
      })
      .then((descriptor) => {
        if (disposed) return
        if (descriptor && !descriptor.platformMissing) {
          boardDetailsCacheRef.current.set(baseKey, descriptor)
          setBoardDetails(descriptor)
        } else {
          // Platform missing or no descriptor: treat as unresolved and clear cache entry
          boardDetailsCacheRef.current.delete(baseKey)
          setBoardDetails(undefined)
          if (descriptor?.platformMissing) {
            setBoardDetailsError('Required platform not installed')
          }
        }
      })
      .catch((err) => {
        if (disposed) return
        console.error('Failed to resolve board details', err)
        setBoardDetails(undefined)
        setBoardDetailsError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!disposed && useLoading) {
          setBoardDetailsLoading(false)
        }
      })
    return () => {
      disposed = true
    }
  }, [selectedProfile?.name, selectedProfile?.fqbn, documentUri])

  const buildMasterTreeItems = useCallback((): ReadonlyArray<TreeNode> => {
    const items: TreeNode[] = []
    // Draft profile (if any)
    if (draftProfile) {
      const isActive = selectedProfileKey === DRAFT_PROFILE_KEY
      items.push({
        id: DRAFT_PROFILE_KEY,
        label: draftProfile.name || 'New Profile',
        description: (
          <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <>
              <VscodeIcon name="circle-filled" title="Draft profile" />
              <div>Draft</div>
            </>
          </div>
        ),
        branch: false,
        selected: isActive,
        onClick: () => setSelectedProfileKey(DRAFT_PROFILE_KEY),
        // No actions on draft to avoid accidental Enter → destructive
      })
    }

    // Existing profiles
    for (const profile of state.profiles) {
      const profileKey = profile.name
      const isSelected = selectedProfileKey === profileKey
      const isDefault = state.selectedProfile === profile.name
      const isActive = activeProfileName === profile.name
      const actions: TreeNode['actions'] extends infer T ? T : never = [
        ...(isActive
          ? []
          : [
              {
                icon: 'check',
                ariaLabel: `Set ${profile.name} as active`,
                title: 'Set as active',
                onClick: () => {
                  execute(
                    (messenger) =>
                      messenger.sendRequest(
                        profilesSetActiveProfile,
                        HOST_EXTENSION,
                        { uri: documentUri, name: profile.name }
                      ),
                    { suppressBusy: true }
                  )
                },
                disabled: busy,
              },
            ]),
        {
          icon: 'ellipsis',
          ariaLabel: 'More Actions...',
          title: 'More Actions...',
          onClick: (ev) => dispatchContextMenuEvent(ev),
          disabled: busy,
          preserveFocus: true,
          dataAttrs: {
            'vscode-context': createVscodeDataContext({
              webviewSection: 'profiles-master',
              args: [profile.name, documentUri],
              canDelete: true,
              canSetDefault: !isDefault,
              canSetActive: !isActive,
            }),
          },
        },
      ]

      items.push({
        id: profileKey,
        label: profile.name,
        description:
          isActive || isDefault ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              {isActive && (
                <>
                  <VscodeIcon name="check" title="Active profile" />
                  <div>Active</div>
                </>
              )}
              {isDefault && <div>Default</div>}
            </div>
          ) : undefined,
        branch: false,
        selected: isSelected,
        onClick: () => setSelectedProfileKey(profileKey),
        actions,
        defaultAction: 'first',
      })
    }

    if (!state.profiles.length && !draftProfile) {
      items.push({
        id: 'empty',
        label: '',
        description: 'No profiles defined',
        branch: false,
        selected: false,
        actions: undefined,
      })
    }

    return items
  }, [
    busy,
    documentUri,
    draftProfile,
    execute,
    activeProfileName,
    selectedProfileKey,
    state.profiles,
    state.selectedProfile,
  ])

  const handleEditBoard = useCallback(() => {
    if (!selectedProfile) {
      return
    }
    execute((messenger) =>
      messenger.sendRequest(profilesPickBoard, HOST_EXTENSION, {
        uri: documentUri,
        profile: selectedProfile.name,
      })
    )
  }, [selectedProfile, documentUri, execute])

  const handleConfigOptionSelect = useCallback(
    (option: string) => {
      if (!selectedProfile) {
        return
      }
      // Preserve selection on the config option while picker is open and after update
      setSelectedDetailsItem(`config:${option}`)
      execute(
        (messenger) =>
          messenger.sendRequest(
            profilesSelectBoardConfigOption,
            HOST_EXTENSION,
            {
              uri: documentUri,
              profile: selectedProfile.name,
              option,
            }
          ),
        { suppressBusy: true }
      ).then(() => refocusDetailsTree())
    },
    [selectedProfile, documentUri, execute, refocusDetailsTree]
  )

  const handleConfigOptionReset = useCallback(
    (option: string) => {
      if (!selectedProfile) {
        return
      }
      // Preserve selection on the config option while reset occurs
      setSelectedDetailsItem(`config:${option}`)
      execute(
        (messenger) =>
          messenger.sendRequest(
            profilesResetBoardConfigOption,
            HOST_EXTENSION,
            {
              uri: documentUri,
              profile: selectedProfile.name,
              option,
            }
          ),
        { suppressBusy: true }
      ).then(() => refocusDetailsTree())
    },
    [selectedProfile, documentUri, execute, refocusDetailsTree]
  )

  const handleProgrammerChange = useCallback(() => {
    if (!selectedProfile) {
      return
    }
    setSelectedDetailsItem('programmer')
    execute(
      (messenger) =>
        messenger.sendRequest(profilesSelectProgrammer, HOST_EXTENSION, {
          uri: documentUri,
          profile: selectedProfile.name,
        }),
      { suppressBusy: true }
    ).then(() => refocusDetailsTree())
  }, [selectedProfile, documentUri, execute, refocusDetailsTree])

  const handleProgrammerReset = useCallback(() => {
    if (!selectedProfile) {
      return
    }
    setSelectedDetailsItem('programmer')
    execute(
      (messenger) =>
        messenger.sendRequest(profilesSelectProgrammer, HOST_EXTENSION, {
          uri: documentUri,
          profile: selectedProfile.name,
          programmerId: null,
        }),
      { suppressBusy: true }
    ).then(() => refocusDetailsTree())
  }, [selectedProfile, documentUri, execute, refocusDetailsTree])

  const handlePortChange = useCallback(() => {
    if (!selectedProfile) {
      return
    }
    // Keep selection on the port node so focus can be restored after picker
    setSelectedDetailsItem('port')
    execute(
      (messenger) =>
        messenger.sendRequest(profilesSelectPort, HOST_EXTENSION, {
          uri: documentUri,
          profile: selectedProfile.name,
        }),
      { suppressBusy: true }
    ).then(() => refocusDetailsTree())
  }, [selectedProfile, documentUri, execute, refocusDetailsTree])

  const selectedProfileIsDefault =
    Boolean(selectedProfile) && state.selectedProfile === selectedProfile?.name
  const selectedProfileIsActive = useMemo(
    () =>
      Boolean(selectedProfile?.name) &&
      Boolean(activeProfileName) &&
      selectedProfile?.name === activeProfileName,
    [activeProfileName, selectedProfile?.name]
  )

  const programmerLabel = useMemo(() => {
    if (!selectedProfile) {
      return ''
    }
    if (!selectedProfile.programmer) {
      if (boardDetails?.defaultProgrammerId) {
        return `Default (${boardDetails.defaultProgrammerId})`
      }
      return 'Default'
    }
    const matching = boardDetails?.programmers.find(
      (programmer) => programmer.id === selectedProfile.programmer
    )
    return matching ? matching.label : selectedProfile.programmer
  }, [selectedProfile, boardDetails])

  const portIdentifier = useMemo(() => {
    if (!selectedProfile) {
      return undefined
    }
    const address = selectedProfile?.port
    const protocol = selectedProfile?.protocol
    return { address, protocol }
  }, [selectedProfile])

  const handlePlatformAdd = useCallback(async () => {
    if (!selectedProfile) {
      return
    }
    await execute(
      (messenger) =>
        messenger.sendRequest(profilesPickPlatform, HOST_EXTENSION, {
          uri: documentUri,
          profile: selectedProfile.name,
          exclude: selectedProfile.platforms.map((p) => p.platform),
        }),
      { suppressBusy: true }
    )
  }, [selectedProfile, documentUri, execute])

  const handlePlatformSetIndexUrl = useCallback(
    async (platform: ProfilePlatformDescriptor, preferChildFocus?: boolean) => {
      if (!selectedProfile) return
      // Preserve selection even if user cancels the picker
      setSelectedDetailsItem(
        preferChildFocus
          ? `platform-index-url:${platform.platform}`
          : `platform:${platform.platform}${platform.version ? `@${platform.version}` : ''}`
      )
      await execute(
        (messenger) =>
          messenger.sendRequest(profilesPickPlatformIndexUrl, HOST_EXTENSION, {
            uri: documentUri,
            profile: selectedProfile.name,
            platform: platform.platform,
          }),
        { suppressBusy: true }
      )
    },
    [selectedProfile, documentUri, execute]
  )

  const handlePlatformClearIndexUrl = useCallback(
    async (platform: ProfilePlatformDescriptor, preferChildFocus?: boolean) => {
      if (!selectedProfile) return
      // Preserve selection even if user cancels the picker
      setSelectedDetailsItem(
        preferChildFocus
          ? `platform-index-url:${platform.platform}`
          : `platform:${platform.platform}${platform.version ? `@${platform.version}` : ''}`
      )
      await execute(
        (messenger) =>
          messenger.sendRequest(profilesPickPlatformIndexUrl, HOST_EXTENSION, {
            uri: documentUri,
            profile: selectedProfile.name,
            platform: platform.platform,
            clear: true,
          }),
        { suppressBusy: true }
      )
    },
    [selectedProfile, documentUri, execute]
  )

  const handlePortConfigAdd = useCallback(async () => {
    if (!selectedProfile) return
    await execute(
      (messenger) =>
        messenger.sendRequest(profilesAddPortConfig, HOST_EXTENSION, {
          uri: documentUri,
          profile: selectedProfile.name,
          excludeKeys: Object.keys(selectedProfile.portConfig || {}),
        }),
      { suppressBusy: true }
    )
  }, [selectedProfile, documentUri, execute])

  const handlePortConfigEdit = useCallback(
    async (key: string) => {
      if (!selectedProfile) return
      setSelectedDetailsItem(`port-config:${key}`)
      await execute(
        (messenger) =>
          messenger.sendRequest(profilesPickPortConfigValue, HOST_EXTENSION, {
            uri: documentUri,
            profile: selectedProfile.name,
            key,
          }),
        { suppressBusy: true }
      )
    },
    [selectedProfile, documentUri, execute]
  )

  const handlePortConfigRemove = useCallback(
    async (key: string) => {
      if (!selectedProfile) return
      await execute((messenger) =>
        messenger.sendRequest(profilesRemovePortConfig, HOST_EXTENSION, {
          uri: documentUri,
          profile: selectedProfile.name,
          key,
        })
      )
    },
    [selectedProfile, documentUri, execute]
  )

  const handlePlatformRemove = useCallback(
    async (platform: ProfilePlatformDescriptor) => {
      if (!selectedProfile) {
        return
      }
      await execute((messenger) =>
        messenger.sendRequest(removePlatform, HOST_EXTENSION, {
          uri: documentUri,
          profile: selectedProfile.name,
          platform,
        })
      )
    },
    [selectedProfile, documentUri, execute]
  )

  const handlePlatformEdit = useCallback(
    async (platform: ProfilePlatformDescriptor) => {
      if (!selectedProfile) return
      try {
        const result = await execute(
          (messenger) =>
            messenger.sendRequest(profilesPickPlatformVersion, HOST_EXTENSION, {
              uri: documentUri,
              profile: selectedProfile.name,
              platform: platform.platform,
            }),
          { suppressBusy: true }
        )
        if (result) {
          const updated = result.profiles.find(
            (p) => p.name === selectedProfile.name
          )
          const updatedPlat = updated?.platforms.find(
            (p) => p.platform === platform.platform
          )
          if (updatedPlat) {
            setSelectedDetailsItem(
              `platform:${updatedPlat.platform}${updatedPlat.version ? `@${updatedPlat.version}` : ''}`
            )
          }
        }
      } catch (err) {
        console.error('Failed to edit platform version', err)
      }
    },
    [selectedProfile, documentUri, execute]
  )

  const handleLibraryAdd = useCallback(async () => {
    if (!selectedProfile) {
      return
    }
    await execute(
      (messenger) =>
        messenger.sendRequest(profilesPickLibrary, HOST_EXTENSION, {
          uri: documentUri,
          profile: selectedProfile.name,
          exclude: selectedProfile.libraries.map((l) => l.library),
        }),
      { suppressBusy: true }
    )
  }, [selectedProfile, documentUri, execute])

  const handleLibraryRemove = useCallback(
    async (library: ProfileLibraryDescriptor) => {
      if (!selectedProfile) {
        return
      }
      await execute((messenger) =>
        messenger.sendRequest(removeLibrary, HOST_EXTENSION, {
          uri: documentUri,
          profile: selectedProfile.name,
          library,
        })
      )
    },
    [selectedProfile, documentUri, execute]
  )

  const handleLibraryEdit = useCallback(
    async (library: ProfileLibraryDescriptor) => {
      if (!selectedProfile) return
      try {
        const result = await execute(
          (messenger) =>
            messenger.sendRequest(profilesPickLibraryVersion, HOST_EXTENSION, {
              uri: documentUri,
              profile: selectedProfile.name,
              library: library.library,
            }),
          { suppressBusy: true }
        )
        if (result) {
          const updated = result.profiles.find(
            (p) => p.name === selectedProfile.name
          )
          const updatedLib = updated?.libraries.find(
            (l) => l.library === library.library
          )
          if (updatedLib) {
            setSelectedDetailsItem(
              `library:${updatedLib.library}${updatedLib.version ? `@${updatedLib.version}` : ''}`
            )
          }
        }
      } catch (err) {
        console.error('Failed to edit library version', err)
      }
    },
    [selectedProfile, documentUri, execute]
  )

  const canResetConfigOption = useCallback(
    (option: { selectedValue?: string; defaultValue?: string }) => {
      if (!selectedProfile?.fqbn) {
        return false
      }
      if (!option.selectedValue) {
        return false
      }
      if (!option.defaultValue) {
        return true
      }
      return option.selectedValue !== option.defaultValue
    },
    [selectedProfile?.fqbn]
  )

  const activeDraft = isDraftSelected ? draftProfile : undefined

  const pickBoardForDraft = useCallback(async (): Promise<
    BoardDescriptor | undefined
  > => {
    const messenger = vscode.messenger as Messenger | undefined
    if (!messenger) {
      setError('Profiles API is unavailable in this context.')
      return undefined
    }
    try {
      const descriptor = await messenger.sendRequest(
        pickBoardForCreation,
        HOST_EXTENSION,
        { uri: documentUri }
      )
      return descriptor ?? undefined
    } catch (err) {
      console.error('Failed to pick board for new profile', err)
      setError(err instanceof Error ? err.message : String(err))
      return undefined
    }
  }, [documentUri])

  const applyDescriptorToDraft = useCallback(
    (descriptor: BoardDescriptor, existingName?: string) => {
      let defaultName = existingName || descriptor.label || descriptor.fqbn
      try {
        const parsed = new FQBN(descriptor.fqbn)
        defaultName =
          existingName ?? parsed.boardId ?? `${parsed.vendor}-${parsed.arch}`
      } catch {}

      const existingNames = new Set(
        state.profiles.map((profile) => profile.name)
      )
      if (!existingName) {
        let candidate = defaultName || 'new-profile'
        let suffix = 1
        while (existingNames.has(candidate)) {
          candidate = `${defaultName || 'new-profile'}-${suffix++}`
        }
        defaultName = candidate
      }

      const recommendedPlatforms =
        descriptor.recommendedPlatforms &&
        descriptor.recommendedPlatforms.length
          ? descriptor.recommendedPlatforms
          : (() => {
              try {
                const parsed = new FQBN(descriptor.fqbn)
                return [{ platform: `${parsed.vendor}:${parsed.arch}` }]
              } catch {
                return [] as ProfilePlatformDescriptor[]
              }
            })()

      const recommendedLibraries =
        descriptor.recommendedLibraries &&
        descriptor.recommendedLibraries.length
          ? descriptor.recommendedLibraries
          : [{ library: 'ArduinoBuiltins' }]

      setDraftProfile({
        name: defaultName,
        fqbn: descriptor.fqbn,
        platforms: recommendedPlatforms,
        libraries: recommendedLibraries,
        boardDescriptor: descriptor,
      })
      setDraftValidationError(undefined)
      setSelectedProfileKey(DRAFT_PROFILE_KEY)
    },
    [state.profiles]
  )

  const handleAddProfile = useCallback(async () => {
    if (draftProfile) {
      // If a draft is already in progress, just activate it without modal dialogs
      setSelectedProfileKey(DRAFT_PROFILE_KEY)
      return
    }

    // Compute a unique default name: "Untitled N"
    const existing = new Set(state.profiles.map((p) => p.name.toLowerCase()))
    let counter = 1
    const base = 'Untitled'
    let name = `${base} ${counter}`
    while (existing.has(name.toLowerCase())) {
      counter += 1
      name = `${base} ${counter}`
    }

    // Start an empty draft (no board selected yet)
    setDraftProfile({
      name,
      fqbn: '',
      platforms: [],
      libraries: [],
      boardDescriptor: undefined,
      note: '',
    })
    setDraftValidationError(undefined)
    setSelectedProfileKey(DRAFT_PROFILE_KEY)
    setDraftJustCreated(true)
  }, [draftProfile, state.profiles])

  // Focus the draft name field when a new draft is created
  useEffect(() => {
    if (!draftJustCreated || !isDraftSelected || !draftProfile) return
    const el = draftNameInputRef.current as any
    try {
      if (el && typeof el.focus === 'function') {
        el.focus()
      }
      const input = el?.shadowRoot?.querySelector('input') as
        | HTMLInputElement
        | undefined
      if (input) {
        input.focus()
        if (input.value) input.select()
      }
    } catch {}
    setDraftJustCreated(false)
  }, [draftJustCreated, isDraftSelected, draftProfile])

  const handleDraftCancel = useCallback(() => {
    if (!draftProfile) {
      return
    }
    setDraftProfile(undefined)
    setDraftValidationError(undefined)
    const fallback =
      state.selectedProfile ?? state.profiles[0]?.name ?? undefined
    setSelectedProfileKey(fallback)
  }, [draftProfile, state.profiles, state.selectedProfile])

  const handleDraftBoardChange = useCallback(async () => {
    if (!draftProfile) {
      return
    }
    const descriptor = await pickBoardForDraft()
    if (!descriptor) {
      return
    }
    applyDescriptorToDraft(descriptor, draftProfile.name)
  }, [applyDescriptorToDraft, draftProfile, pickBoardForDraft])

  const handleDraftConfigOptionSelect = useCallback(
    async (option: string) => {
      if (!draftProfile?.fqbn) return
      const messenger = vscode.messenger as Messenger | undefined
      if (!messenger) return
      try {
        const result = await messenger.sendRequest(
          profilesPickBoardConfigOptionForCreation,
          HOST_EXTENSION,
          { uri: documentUri, fqbn: draftProfile.fqbn, option }
        )
        if (!result) return
        setDraftProfile((current) =>
          current
            ? {
                ...current,
                fqbn: result.fqbn,
                boardDescriptor: result.descriptor || current.boardDescriptor,
              }
            : current
        )
        refocusDetailsTree()
        setTimeout(() => setSelectedDetailsItem(undefined), 200)
      } catch (err) {
        console.error('Failed to update draft config option', err)
      }
    },
    [draftProfile?.fqbn, documentUri, refocusDetailsTree]
  )

  const handleDraftConfigOptionReset = useCallback(
    async (option: string) => {
      if (!draftProfile?.fqbn) return
      const messenger = vscode.messenger as Messenger | undefined
      if (!messenger) return
      try {
        const result = await messenger.sendRequest(
          profilesResetBoardConfigOptionForCreation,
          HOST_EXTENSION,
          { uri: documentUri, fqbn: draftProfile.fqbn, option }
        )
        if (!result) return
        setDraftProfile((current) =>
          current
            ? {
                ...current,
                fqbn: result.fqbn,
                boardDescriptor: result.descriptor || current.boardDescriptor,
              }
            : current
        )
        refocusDetailsTree()
        setTimeout(() => setSelectedDetailsItem(undefined), 200)
      } catch (err) {
        console.error('Failed to reset draft config option', err)
      }
    },
    [draftProfile?.fqbn, documentUri, refocusDetailsTree]
  )

  const handleDraftProgrammerChange = useCallback(async () => {
    if (!draftProfile?.fqbn) return
    const messenger = vscode.messenger as Messenger | undefined
    if (!messenger) return
    setSelectedDetailsItem('programmer')
    try {
      const result = await messenger.sendRequest(
        profilesPickProgrammerForCreation,
        HOST_EXTENSION,
        { uri: documentUri, fqbn: draftProfile.fqbn }
      )
      if (!result) return
      setDraftProfile((current) =>
        current
          ? { ...current, programmer: result.programmerId ?? undefined }
          : current
      )
      refocusDetailsTree()
      setTimeout(() => setSelectedDetailsItem(undefined), 200)
    } catch (err) {
      console.error('Failed to pick draft programmer', err)
    }
  }, [draftProfile?.fqbn, documentUri, refocusDetailsTree])

  const handleDraftProgrammerReset = useCallback(() => {
    if (!draftProfile) return
    setSelectedDetailsItem('programmer')
    setDraftProfile((current) =>
      current ? { ...current, programmer: undefined } : current
    )
  }, [draftProfile])

  const handleDraftPortChange = useCallback(async () => {
    const messenger = vscode.messenger as Messenger | undefined
    if (!messenger) return
    // Keep selection on the port node so focus can be restored after picker
    setSelectedDetailsItem('port')
    try {
      const result = await messenger.sendRequest(
        profilesPickPortForCreation,
        HOST_EXTENSION,
        { uri: documentUri }
      )
      if (!result) return
      setDraftProfile((current) =>
        current
          ? { ...current, port: result.port, protocol: result.protocol }
          : current
      )
      refocusDetailsTree()
    } catch (err) {
      console.error('Failed to pick draft port', err)
    }
  }, [documentUri, refocusDetailsTree])

  const handleDraftPortConfigAdd = useCallback(async () => {
    if (!draftProfile?.protocol) return
    const messenger = vscode.messenger as Messenger | undefined
    if (!messenger) return
    try {
      const picked = await messenger.sendRequest(
        profilesPickPortConfigForCreation,
        HOST_EXTENSION,
        {
          uri: documentUri,
          protocol: draftProfile.protocol,
          fqbn: draftProfile.fqbn,
        }
      )
      if (!picked) return
      setDraftProfile((current) =>
        current
          ? {
              ...current,
              portConfig: {
                ...(current.portConfig || {}),
                [picked.key]: picked.value,
              },
            }
          : current
      )
    } catch (err) {
      console.error('Failed to add draft port config', err)
    }
  }, [draftProfile?.protocol, draftProfile?.fqbn, documentUri])

  const handleDraftPortConfigEdit = useCallback(
    async (key: string) => {
      if (!draftProfile?.protocol) return
      const messenger = vscode.messenger as Messenger | undefined
      if (!messenger) return
      try {
        const value = await messenger.sendRequest(
          profilesPickPortConfigValueForCreation,
          HOST_EXTENSION,
          {
            uri: documentUri,
            protocol: draftProfile.protocol,
            fqbn: draftProfile.fqbn,
            key,
          }
        )
        if (!value) return
        setDraftProfile((current) =>
          current
            ? {
                ...current,
                portConfig: { ...(current.portConfig || {}), [key]: value },
              }
            : current
        )
      } catch (err) {
        console.error('Failed to edit draft port config', err)
      }
    },
    [draftProfile?.protocol, draftProfile?.fqbn, documentUri]
  )

  const handleDraftPortConfigRemove = useCallback(
    (key: string) => {
      if (!draftProfile) return
      setDraftProfile((current) => {
        if (!current) return current
        const next = { ...(current.portConfig || {}) }
        delete (next as any)[key]
        return { ...current, portConfig: next }
      })
    },
    [draftProfile]
  )

  const handleDraftPlatformAdd = useCallback(async () => {
    if (!draftProfile) return
    const messenger = vscode.messenger as Messenger | undefined
    if (!messenger) return
    setDraftValidationError(undefined)
    try {
      const picked = await messenger.sendRequest(
        profilesPickPlatformForCreation,
        HOST_EXTENSION,
        { uri: documentUri }
      )
      if (!picked) return
      setDraftProfile((current) =>
        current
          ? {
              ...current,
              platforms: current.platforms.some(
                (p) => p.platform === picked.platform
              )
                ? current.platforms.map((p) =>
                    p.platform === picked.platform ? picked : p
                  )
                : [...current.platforms, picked],
            }
          : current
      )
      setSelectedDetailsItem(
        `platform:${picked.platform}${picked.version ? `@${picked.version}` : ''}`
      )
    } catch (err) {
      console.error('Draft platform add failed', err)
    }
  }, [draftProfile, documentUri])

  const handleDraftPlatformRemove = useCallback(
    (index: number) => {
      if (!draftProfile) {
        return
      }
      setDraftProfile({
        ...draftProfile,
        platforms: draftProfile.platforms.filter((_, i) => i !== index),
      })
      setDraftValidationError(undefined)
    },
    [draftProfile]
  )

  const handleDraftPlatformEdit = useCallback(
    async (platform: ProfilePlatformDescriptor) => {
      if (!draftProfile) return
      const messenger = vscode.messenger as Messenger | undefined
      if (!messenger) return
      try {
        const version = await messenger.sendRequest(
          profilesPickPlatformVersionForCreation,
          HOST_EXTENSION,
          { uri: documentUri, platform: platform.platform }
        )
        if (!version) return
        setDraftProfile((current) =>
          current
            ? {
                ...current,
                platforms: current.platforms.map((p) =>
                  p.platform === platform.platform ? { ...p, version } : p
                ),
              }
            : current
        )
        setSelectedDetailsItem(
          `platform:${platform.platform}${version ? `@${version}` : ''}`
        )
      } catch (err) {
        console.error('Draft platform edit failed', err)
      }
    },
    [draftProfile, documentUri]
  )

  const handleDraftLibraryAdd = useCallback(async () => {
    if (!draftProfile) return
    const messenger = vscode.messenger as Messenger | undefined
    if (!messenger) return
    setDraftValidationError(undefined)
    try {
      const picked = await messenger.sendRequest(
        profilesPickLibraryForCreation,
        HOST_EXTENSION,
        { uri: documentUri }
      )
      if (!picked) return
      setDraftProfile((current) =>
        current
          ? {
              ...current,
              libraries: current.libraries.some(
                (l) => l.library === picked.library
              )
                ? current.libraries.map((l) =>
                    l.library === picked.library ? picked : l
                  )
                : [...current.libraries, picked],
            }
          : current
      )
      setSelectedDetailsItem(
        `library:${picked.library}${picked.version ? `@${picked.version}` : ''}`
      )
    } catch (err) {
      console.error('Draft library add failed', err)
    }
  }, [draftProfile, documentUri])

  const handleDraftLibraryRemove = useCallback(
    (index: number) => {
      if (!draftProfile) {
        return
      }
      setDraftProfile({
        ...draftProfile,
        libraries: draftProfile.libraries.filter((_, i) => i !== index),
      })
      setDraftValidationError(undefined)
    },
    [draftProfile]
  )

  const handleDraftLibraryEdit = useCallback(
    async (library: ProfileLibraryDescriptor) => {
      if (!draftProfile) return
      const messenger = vscode.messenger as Messenger | undefined
      if (!messenger) return
      try {
        const version = await messenger.sendRequest(
          profilesPickLibraryVersionForCreation,
          HOST_EXTENSION,
          { uri: documentUri, library: library.library }
        )
        if (!version) return
        setDraftProfile((current) =>
          current
            ? {
                ...current,
                libraries: current.libraries.map((l) =>
                  l.library === library.library ? { ...l, version } : l
                ),
              }
            : current
        )
        setSelectedDetailsItem(
          `library:${library.library}${version ? `@${version}` : ''}`
        )
      } catch (err) {
        console.error('Draft library edit failed', err)
      }
    },
    [draftProfile, documentUri]
  )

  const handleDraftCreate = useCallback(async () => {
    if (!draftProfile) {
      return
    }
    const trimmedName = draftProfile.name.trim()
    if (!trimmedName) {
      setDraftValidationError('Profile name is required.')
      return
    }
    if (state.profiles.some((profile) => profile.name === trimmedName)) {
      setDraftValidationError('A profile with this name already exists.')
      return
    }
    if (!draftProfile.platforms.length) {
      setDraftValidationError('At least one platform is required.')
      return
    }

    const payload = {
      name: trimmedName,
      fqbn: draftProfile.fqbn,
      port: draftProfile.port,
      protocol: draftProfile.protocol,
      portConfig: draftProfile.portConfig,
      platforms: draftProfile.platforms,
      libraries: draftProfile.libraries,
      note:
        draftProfile.note && draftProfile.note.trim().length
          ? draftProfile.note
          : undefined,
    }

    const result = await execute((messenger) =>
      messenger.sendRequest(createProfile, HOST_EXTENSION, {
        uri: documentUri,
        profile: payload,
      })
    )

    if (result) {
      setDraftProfile(undefined)
      setDraftValidationError(undefined)
      setSelectedProfileKey(trimmedName)
    }
  }, [documentUri, draftProfile, execute, state.profiles])

  return (
    <div
      className="profiles-editor"
      // Disable default menu items; enable webview context contributions
      data-vscode-context={JSON.stringify(preventDefaultContextMenuItems)}
    >
      <VscodeSplitLayout
        split="vertical"
        className="profiles-editor__split"
        initialHandlePosition="25%"
        resetOnDblClick
        minStart="240px"
        fixedPane="start"
      >
        <div slot="start" className="profiles-editor__list-pane">
          <div className="profiles-editor__list-header">
            <VscodeButtonGroup>
              <VscodeButton onClick={handleAddProfile} disabled={busy}>
                New Profile
              </VscodeButton>
              {/* <VscodeButton icon="chevron-down" title="More actions..." /> */}
            </VscodeButtonGroup>
          </div>
          <VscodeScrollable
            className="profile-view__tree-container"
            tabIndex={0}
            role="tree"
          >
            <Tree
              className="profiles-editor__tree"
              ariaLabel="Profiles"
              items={buildMasterTreeItems()}
            />
          </VscodeScrollable>
        </div>
        <div slot="end" className="profiles-editor__details-pane">
          {activeDraft ? (
            <>
              <header className="profiles-editor__details-header">
                <div className="profiles-editor__details-title">
                  <div className="title">
                    {activeDraft.name || 'New Profile'}
                  </div>
                  <VscodeBadge variant="default">
                    <div className="badge-content">
                      <div>Draft</div>
                    </div>
                  </VscodeBadge>
                </div>
              </header>

              <VscodeScrollable className="profiles-editor__details-scroll">
                <div className="profiles-editor__details">
                  {draftValidationError ? (
                    <div className="profiles-editor__error">
                      {draftValidationError}
                    </div>
                  ) : null}
                  <ProfileNameSection
                    inputRef={draftNameInputRef}
                    value={activeDraft.name}
                    onChange={(next) => {
                      setDraftProfile((current) =>
                        current ? { ...current, name: next } : current
                      )
                    }}
                  />
                  <NoteSection
                    value={activeDraft.note ?? ''}
                    onChange={(next) => {
                      setDraftProfile((current) =>
                        current ? { ...current, note: next } : current
                      )
                    }}
                  />
                  <Tree
                    className="profiles-details-tree tree--actions-on-hover"
                    ariaLabel={`Draft ${activeDraft.name || 'New Profile'} details`}
                    expandMode="singleClick"
                    items={buildDraftDetailsTree(
                      activeDraft,
                      {
                        busy,
                        detectedPorts,
                        programmerLabel: activeDraft.programmer
                          ? activeDraft.programmer
                          : activeDraft.boardDescriptor?.defaultProgrammerId
                            ? `Default (${activeDraft.boardDescriptor.defaultProgrammerId})`
                            : 'Default',
                        portLabel: activeDraft.port
                          ? activeDraft.protocol
                            ? `${activeDraft.port} (${activeDraft.protocol})`
                            : activeDraft.port
                          : 'No port selected',
                        platformNames,
                        portConfigLabels,
                      },
                      {
                        handleEditBoard: handleDraftBoardChange,
                        handleProgrammerChange: handleDraftProgrammerChange,
                        handleProgrammerReset: handleDraftProgrammerReset,
                        handlePortChange: handleDraftPortChange,
                        handlePortConfigAdd: handleDraftPortConfigAdd,
                        handlePortConfigEdit: handleDraftPortConfigEdit,
                        handlePortConfigRemove: handleDraftPortConfigRemove,
                        handleConfigOptionSelect: handleDraftConfigOptionSelect,
                        handleConfigOptionReset: handleDraftConfigOptionReset,
                        handlePlatformAdd: handleDraftPlatformAdd,
                        handlePlatformEdit: handleDraftPlatformEdit,
                        handlePlatformRemove: (p) => {
                          const idx = activeDraft.platforms.findIndex(
                            (x) => x.platform === p.platform
                          )
                          if (idx >= 0) handleDraftPlatformRemove(idx)
                        },
                        handleLibraryAdd: handleDraftLibraryAdd,
                        handleLibraryEdit: handleDraftLibraryEdit,
                        handleLibraryRemove: (l) => {
                          const idx = activeDraft.libraries.findIndex(
                            (x) => x.library === l.library
                          )
                          if (idx >= 0) handleDraftLibraryRemove(idx)
                        },
                      },
                      selectedDetailsItem
                    )}
                  />
                </div>
              </VscodeScrollable>

              <div className="profiles-editor__draft-actions">
                <VscodeButton
                  secondary
                  onClick={handleDraftCancel}
                  disabled={busy}
                >
                  Cancel
                </VscodeButton>
                <VscodeButton onClick={handleDraftCreate} disabled={busy}>
                  Create
                </VscodeButton>
              </div>
            </>
          ) : !selectedProfile ? (
            <div className="profiles-editor__empty-state">
              Select a profile to see details.
            </div>
          ) : (
            <>
              <header className="profiles-editor__details-header">
                <div className="profiles-editor__details-title">
                  <div className="title">{selectedProfile.name}</div>
                  {selectedProfileIsActive && (
                    <VscodeBadge variant="tab-header-counter">
                      <div className="badge-content">
                        <VscodeIcon name="check" />
                        <div>Active</div>
                      </div>
                    </VscodeBadge>
                  )}
                  {selectedProfileIsDefault && (
                    <VscodeBadge variant="default">
                      <div className="badge-content">
                        <div>Default</div>
                      </div>
                    </VscodeBadge>
                  )}
                </div>
              </header>

              <VscodeScrollable className="profiles-editor__details-scroll">
                <div className="profiles-editor__details">
                  <ProfileNameSection
                    value={pendingProfileName ?? ''}
                    onChange={(next) => setPendingProfileName(next)}
                    onCommit={async (newName: string) => {
                      const oldName = selectedProfile?.name ?? ''
                      if (!newName || newName === oldName) return
                      try {
                        const result = await execute(
                          (messenger) =>
                            messenger.sendRequest(
                              profilesRenameProfile,
                              HOST_EXTENSION,
                              { uri: documentUri, from: oldName, to: newName }
                            ),
                          { suppressBusy: true, refocus: false }
                        )
                        if (result) {
                          setSelectedProfileKey(newName)
                        }
                      } catch (err) {
                        console.error('Failed to rename profile', err)
                        setPendingProfileName(oldName)
                      }
                    }}
                  />
                  {error && (
                    <div className="profiles-editor__error">{error}</div>
                  )}
                  {(() => {
                    const detailsItems = buildDetailsTree(
                      selectedProfile,
                      boardDetails,
                      {
                        busy,
                        boardDetailsLoading,
                        portIdentifier,
                        detectedPorts,
                        programmerLabel,
                        platformNames,
                        unresolvedPlatforms,
                        portConfigLabels,
                      },
                      {
                        handleEditBoard,
                        handleProgrammerChange,
                        handleProgrammerReset,
                        handlePortChange,
                        handlePortConfigAdd,
                        handlePortConfigEdit,
                        handlePortConfigRemove,
                        handleConfigOptionSelect,
                        handleConfigOptionReset,
                        canResetConfigOption,
                        handlePlatformAdd,
                        handlePlatformEdit,
                        handlePlatformRemove,
                        handlePlatformSetIndexUrl,
                        handlePlatformClearIndexUrl,
                        handleLibraryAdd,
                        handleLibraryEdit,
                        handleLibraryRemove,
                      },
                      selectedDetailsItem
                    )
                    const problems = buildProblemsTree(
                      profileDiagnostics,
                      (range) => {
                        const messenger = vscode.messenger as
                          | Messenger
                          | undefined
                        if (!messenger || !range) return
                        messenger
                          .sendRequest(profilesRevealRange, HOST_EXTENSION, {
                            uri: documentUri,
                            range,
                          })
                          .catch(() => {})
                      },
                      async (kind) => {
                        // Navigate to relevant details section
                        if (kind === 'platforms') {
                          setSelectedDetailsItem('platforms')
                          refocusDetailsTree()
                        } else if (kind === 'libraries') {
                          setSelectedDetailsItem('libraries')
                          refocusDetailsTree()
                        }
                      },
                      { uri: documentUri, profile: selectedProfile.name },
                      (diag, ev, ctx) => {
                        if (!ctx || !diag.range) {
                          dispatchContextMenuEvent(ev)
                          return
                        }

                        const messenger = vscode.messenger
                        if (!messenger) {
                          dispatchContextMenuEvent(ev)
                          return
                        }

                        const rect = ev.currentTarget.getBoundingClientRect()
                        const x = rect.right
                        const y = rect.bottom

                        try {
                          messenger
                            .sendRequest(
                              profilesListQuickFixes,
                              HOST_EXTENSION,
                              {
                                uri: ctx.uri,
                                profile: ctx.profile,
                                range: diag.range!,
                              }
                            )
                            .then((fixes) => {
                              const items = fixes.map(
                                (f: { title: string; fixId: string }) => ({
                                  label: f.title,
                                  value: f.fixId,
                                })
                              )
                              if (!items.length) {
                                dispatchContextMenuEvent(ev)
                                return
                              }
                              setQuickFixMenu({
                                show: true,
                                x,
                                y,
                                items,
                                context: { uri: ctx.uri },
                              })
                            })
                            .catch(() => {
                              dispatchContextMenuEvent(ev)
                            })
                        } catch {
                          dispatchContextMenuEvent(ev)
                        }
                      },
                      profileDiagnosticsLoading
                    )
                    const items = problems.length
                      ? [...problems, ...detailsItems]
                      : detailsItems
                    return (
                      <Tree
                        className="profiles-details-tree tree--actions-on-hover"
                        ariaLabel={`Profile ${selectedProfile.name} details`}
                        expandMode="singleClick"
                        items={items}
                      />
                    )
                  })()}
                  <NoteSection
                    value={pendingNote}
                    onChange={(next) => setPendingNote(next)}
                    onCommit={async (next: string) => {
                      try {
                        await execute(
                          (messenger) =>
                            messenger.sendRequest(
                              updateProfile,
                              HOST_EXTENSION,
                              {
                                uri: documentUri,
                                name: selectedProfile!.name,
                                patch: { note: next },
                              }
                            ),
                          { suppressBusy: true, refocus: false }
                        )
                      } catch (err) {
                        console.error('Failed to update note', err)
                      }
                    }}
                  />
                </div>
              </VscodeScrollable>
            </>
          )}
        </div>
        {quickFixMenu.show && (
          <VscodeContextMenu
            slot="end"
            style={{
              position: 'fixed',
              left: `${quickFixMenu.x}px`,
              top: `${quickFixMenu.y}px`,
              zIndex: 1000,
              width: 'max-content',
              height: 'auto',
            }}
            show={quickFixMenu.show}
            data={quickFixMenu.items}
            onVscContextMenuSelect={(e: any) => {
              const detail = e.detail || {}
              const value = detail.value as string | undefined
              const ctx = quickFixMenu.context
              const messenger = vscode.messenger as Messenger | undefined
              setQuickFixMenu((prev) => ({ ...prev, show: false }))
              if (!value || !ctx || !messenger) return
              try {
                messenger.sendRequest(
                  profilesApplyQuickFixById,
                  HOST_EXTENSION,
                  {
                    uri: ctx.uri,
                    fixId: value,
                  }
                )
              } catch {}
            }}
          />
        )}
      </VscodeSplitLayout>
    </div>
  )
}

const iconFor = (sev: string): string =>
  sev === 'error'
    ? 'error'
    : sev === 'warning'
      ? 'warning'
      : sev === 'hint'
        ? 'question'
        : 'info'

function buildProblemsTree(
  diagnostics: ReadonlyArray<{
    message: string
    severity: 'error' | 'warning' | 'information' | 'hint'
    range?: {
      start: { line: number; character: number }
      end: { line: number; character: number }
    }
  }>,
  onReveal?: (range?: {
    start: { line: number; character: number }
    end: { line: number; character: number }
  }) => void,
  onGoToSection?: (kind: 'platforms' | 'libraries' | 'board' | 'port') => void,
  context?: { uri: string; profile: string },
  onQuickFixClick?: (
    diag: {
      message: string
      severity: 'error' | 'warning' | 'information' | 'hint'
      range?: {
        start: { line: number; character: number }
        end: { line: number; character: number }
      }
    },
    ev: any,
    ctx?: { uri: string; profile: string }
  ) => void,
  loading?: boolean
): TreeNode[] {
  if (loading) {
    const icon = (
      <span className="problem-icon-wrap">
        <VscodeIcon
          name="sync"
          spin
          className="problem-icon problem-icon--severity"
        />
      </span>
    )
    return [
      {
        id: 'problems',
        icon,
        openedIcon: icon,
        label: (
          <span className="tree-item__label">
            <span className="tree-item__labelText">Problems</span>
          </span>
        ),
        description: 'Validating profile…',
        branch: false,
        open: false,
        dataAttrs: {
          'problems-severity': 'information',
          'problems-loading': true,
        },
        decoration: (
          <VscodeBadge variant="counter" aria-label="Validating">
            …
          </VscodeBadge>
        ),
      },
    ]
  }

  if (!diagnostics.length) {
    const icon = (
      <span className="problem-icon-wrap">
        <VscodeIcon
          name="pass"
          className="problem-icon problem-icon--success"
        />
      </span>
    )
    return [
      {
        id: 'problems',
        icon,
        openedIcon: icon,
        label: (
          <span className="tree-item__label">
            <span className="tree-item__labelText">Problems</span>
          </span>
        ),
        description: 'No issues detected',
        branch: false,
        open: false,
        dataAttrs: {
          'problems-severity': 'information',
        },
        decoration: <VscodeBadge variant="counter">0</VscodeBadge>,
      },
    ]
  }

  const counts = diagnostics.reduce(
    (acc, d) => {
      acc.total++
      acc[d.severity] = (acc[d.severity] || 0) + 1
      return acc
    },
    { total: 0, error: 0, warning: 0, information: 0, hint: 0 }
  )

  const children: TreeNode[] = diagnostics.map((d, i) => {
    const lower = d.message.toLowerCase()
    const section: 'platforms' | 'libraries' | undefined = lower.includes(
      'library'
    )
      ? 'libraries'
      : lower.includes('platform')
        ? 'platforms'
        : undefined
    const actions: any[] = []
    if (d.range) {
      actions.push({
        icon: 'go-to-file' as const,
        ariaLabel: 'Open in text editor',
        title: 'Open in text editor',
        onClick: () => onReveal?.(d.range!),
      })
    }
    if (section && onGoToSection) {
      actions.push({
        icon: 'arrow-right',
        ariaLabel: 'Reveal in details',
        title: 'Reveal in details',
        onClick: () => onGoToSection(section),
      })
    }
    const dataAttrs: Record<string, string | number | boolean | undefined> = {}
    return {
      id: `diag:${i}`,
      icon: (
        <span
          className="problem-icon-wrap problem-icon-action"
          tabIndex={0}
          role="button"
          aria-haspopup="menu"
          onPointerDownCapture={(ev: any) => {
            if (context && onQuickFixClick && d.range) {
              ev.preventDefault()
              ev.stopPropagation()
              const native = ev.nativeEvent
              if (
                native &&
                typeof native.stopImmediatePropagation === 'function'
              ) {
                native.stopImmediatePropagation()
              }
              onQuickFixClick(d, ev, context)
            } else {
              dispatchContextMenuEvent(ev)
            }
          }}
        >
          <VscodeIcon
            name={iconFor(d.severity)}
            className={`problem-icon problem-icon--severity problem-icon--${d.severity}`}
          />
          <VscodeIcon
            name="lightbulb"
            className="problem-icon problem-icon--lightbulb"
          />
        </span>
      ),
      label: (
        <span className="tree-item__label">
          <span className="tree-item__labelText">{d.message}</span>
        </span>
      ),
      description: d.range
        ? `[Ln ${d.range.start.line + 1}, Col ${d.range.start.character + 1}]`
        : undefined,
      defaultAction: 'last',
      actions,
      dataAttrs,
    }
  })
  const rootSeverity: 'error' | 'warning' | 'information' = counts.error
    ? 'error'
    : counts.warning
      ? 'warning'
      : 'information'

  const icon = (
    <span className="problem-icon-wrap">
      <VscodeIcon
        name={
          rootSeverity === 'error'
            ? 'error'
            : rootSeverity === 'warning'
              ? 'warning'
              : 'info'
        }
        className={`problem-icon problem-icon--severity problem-icon--${rootSeverity}`}
      />
    </span>
  )
  return [
    {
      id: 'problems',
      icon,
      openedIcon: icon,
      label: (
        <span className="tree-item__label">
          <span className="tree-item__labelText">Problems</span>
        </span>
      ),
      branch: true,
      open: true,
      dataAttrs: {
        'problems-severity': rootSeverity,
      },
      decoration: (
        <VscodeBadge variant="counter">{diagnostics.length}</VscodeBadge>
      ),
      children,
    },
  ]
}

function buildDetailsTree(
  activeProfile: ProfilesDocumentState['profiles'][number],
  boardDetails: BoardDescriptor | undefined,
  ctx: {
    busy: boolean
    boardDetailsLoading: boolean
    portIdentifier?: { address?: string; protocol?: string }
    detectedPorts?: DetectedPorts
    programmerLabel: string
    platformNames: Record<string, string>
    unresolvedPlatforms?: Record<string, true>
    portConfigLabels: Record<string, string>
  },
  actions: {
    handleEditBoard: () => void
    handleProgrammerChange: () => void
    handleProgrammerReset: () => void
    handlePortChange: () => void
    handlePortConfigAdd: () => void
    handlePortConfigEdit: (key: string) => void
    handlePortConfigRemove: (key: string) => void
    handleConfigOptionSelect: (option: string) => void
    handleConfigOptionReset: (option: string) => void
    canResetConfigOption: (o: {
      selectedValue?: string
      defaultValue?: string
    }) => boolean
    handlePlatformAdd: () => void
    handlePlatformRemove: (p: ProfilePlatformDescriptor) => void
    handlePlatformEdit: (p: ProfilePlatformDescriptor) => void
    handlePlatformSetIndexUrl: (
      p: ProfilePlatformDescriptor,
      preferChildFocus?: boolean
    ) => void
    handlePlatformClearIndexUrl: (
      p: ProfilePlatformDescriptor,
      preferChildFocus?: boolean
    ) => void
    handleLibraryAdd: () => void
    handleLibraryRemove: (l: ProfileLibraryDescriptor) => void
    handleLibraryEdit: (l: ProfileLibraryDescriptor) => void
  },
  selectedKey?: string
): TreeNode[] {
  const items: TreeNode[] = []
  // Determine whether current board details match the active FQBN (same base board) and not missing
  const isResolved = (() => {
    if (!boardDetails || !activeProfile.fqbn) {
      return false
    }
    try {
      const baseActive = new FQBN(activeProfile.fqbn).toString(true)
      const baseDetails = new FQBN(boardDetails.fqbn).toString(true)
      return baseActive === baseDetails && !boardDetails.platformMissing
    } catch {
      return false
    }
  })()

  // Parse/sanitize FQBN for display
  const sanitizedFqbn = (() => {
    if (!activeProfile.fqbn) return undefined
    const parsed = isValidFQBN(activeProfile.fqbn)
    return parsed ? parsed.toString(true) : activeProfile.fqbn
  })()
  const boardLabel = isResolved
    ? (boardDetails?.label ?? sanitizedFqbn ?? 'Board')
    : (sanitizedFqbn ?? 'Board')
  const boardChildren: TreeNode[] = []

  // Config options
  if (isResolved && boardDetails?.configOptions?.length) {
    for (const option of boardDetails.configOptions) {
      const modified = actions.canResetConfigOption(option)
      boardChildren.push({
        id: `config:${option.option}`,
        label: (
          <span className="tree-item__label">
            <span className="tree-item__labelText">{option.optionLabel}</span>
          </span>
        ),
        description: option.selectedValueLabel ?? 'Not set',
        dataAttrs: {
          'profile-item': `config:${option.option}`,
        },
        selected: selectedKey === `config:${option.option}`,
        actions: [
          {
            icon: 'discard',
            ariaLabel: 'Reset option',
            title: 'Reset option',
            onClick: () => actions.handleConfigOptionReset(option.option),
            disabled: ctx.busy || ctx.boardDetailsLoading || !modified,
          },
          {
            icon: 'edit',
            ariaLabel: 'Edit option',
            title: 'Edit option',
            onClick: () => actions.handleConfigOptionSelect(option.option),
            disabled: ctx.busy || ctx.boardDetailsLoading,
          },
        ],
      })
    }
  } else if (!isResolved && activeProfile.fqbn) {
    // Show unresolved config options from the FQBN while details are loading/unavailable
    const parsed = isValidFQBN(activeProfile.fqbn)
    const options = parsed?.options
    if (options && Object.keys(options).length) {
      for (const [key, value] of Object.entries(options)) {
        boardChildren.push({
          id: `config-unresolved:${key}`,
          label: (
            <span className="tree-item__label">
              <span className="tree-item__labelText">{key}</span>
            </span>
          ),
          description: String(value ?? ''),
          dataAttrs: {
            'profile-item': `config:${key}`,
          },
          selected: selectedKey === `config:${key}`,
          // No actions when unresolved
        })
      }
    }
  } else if (isResolved && boardDetails && !boardDetails.configOptions.length) {
    boardChildren.push({
      id: 'no-config',
      label: '',
      description: 'This board has no configurable options',
    })
  }

  let boardDescription = 'No board selected'
  if (activeProfile.fqbn) {
    const parsed = isValidFQBN(activeProfile.fqbn)
    if (isResolved) {
      // Resolved: show sanitized FQBN in the description
      boardDescription = parsed ? parsed.toString(true) : activeProfile.fqbn
    } else if (parsed) {
      // Not resolved: show platform not installed with vendor:arch
      boardDescription = `(${parsed.vendor}:${parsed.arch} platform is not installed)`
    } else {
      boardDescription = activeProfile.fqbn
    }
  }
  items.push({
    id: 'board',
    label: (
      <span className="tree-item__label">
        <span className="tree-item__labelText">{boardLabel}</span>
      </span>
    ),
    icon: 'circuit-board',
    description: boardDescription,
    selected: selectedKey === 'board',
    dataAttrs: { 'profile-item': 'board' },
    actions: [
      {
        icon: 'edit',
        ariaLabel: 'Change board',
        title: 'Change board',
        onClick: actions.handleEditBoard,
        disabled: ctx.busy,
      },
    ],
    branch: true,
    open: true,
    children: boardChildren,
  })

  // Programmer root
  items.push({
    id: 'programmer',
    label: (
      <span className="tree-item__label">
        <span className="tree-item__labelText">Programmer</span>
      </span>
    ),
    icon: 'tools',
    description: ctx.programmerLabel,
    selected: selectedKey === 'programmer',
    dataAttrs: { 'profile-item': 'programmer' },
    actions: [
      {
        icon: 'edit',
        ariaLabel: 'Change programmer',
        title: 'Change programmer',
        onClick: actions.handleProgrammerChange,
        disabled: ctx.busy || !isResolved || ctx.boardDetailsLoading,
      },
      {
        icon: 'discard',
        ariaLabel: 'Reset programmer',
        title: 'Reset programmer',
        onClick: actions.handleProgrammerReset,
        disabled: ctx.busy || !activeProfile.programmer,
      },
    ],
  })

  // Port root with settings children
  const portConfigEntries = Object.entries(activeProfile.portConfig || {})
  // Protocol inference: treat undefined as 'serial' for detection/icon purposes only
  const effectiveProtocol = activeProfile.protocol || 'serial'
  // Determine detection status by matching address+protocol against detected ports
  let portIcon: string | undefined
  let portDescription = 'No port selected'
  const address = activeProfile.port
  const protocol = activeProfile.protocol // for display only; do not infer 'serial' into description
  const detected = (() => {
    if (!address) return undefined
    const key = createPortKey({ address, protocol: effectiveProtocol as any })
    const match = (ctx.detectedPorts as any)?.[key]
    return match
  })()
  if (address) {
    if (detected) {
      // Icon by detected protocol
      const proto = detected.port.protocol
      if (proto === 'serial') portIcon = 'plug'
      else if (proto === 'network') portIcon = 'radio-tower'
      else portIcon = 'extensions'
      // Description: show address and explicit protocol if present in profile
      portDescription = address + (protocol ? ` (${protocol})` : '')
    } else {
      // Not detected: no icon and mark as not detected
      portIcon = undefined
      portDescription = `${address} (not detected)`
    }
  }

  const portChildren: TreeNode[] = portConfigEntries.map(([k, v]) => ({
    id: `port-config:${k}`,
    label: (
      <span className="tree-item__label">
        <span className="tree-item__labelText">
          {ctx.portConfigLabels[k] || k}
        </span>
      </span>
    ),
    description: String(v),
    defaultAction: 'last',
    dataAttrs: {
      'profile-item': `port-config:${k}`,
    },
    selected: selectedKey === `port-config:${k}`,
    actions: [
      {
        icon: 'trash',
        ariaLabel: `Remove ${k}`,
        title: 'Remove',
        onClick: () => actions.handlePortConfigRemove(k),
        disabled: ctx.busy,
      },
      {
        icon: 'edit',
        ariaLabel: `Change value for ${k}`,
        title: 'Change value',
        onClick: () => actions.handlePortConfigEdit(k),
        disabled: ctx.busy || !activeProfile.protocol,
      },
    ],
  }))
  if (!portChildren.length) {
    portChildren.push({
      id: 'no-port-config',
      label: '',
      description: 'No additional port configs',
    })
  }
  items.push({
    id: 'port',
    label: (
      <span className="tree-item__label">
        <span className="tree-item__labelText">Port</span>
      </span>
    ),
    icon: portIcon,
    description: portDescription,
    selected: selectedKey === 'port',
    dataAttrs: { 'profile-item': 'port' },
    actions: [
      {
        icon: 'plus',
        ariaLabel: 'Add port config',
        title: 'Add port config',
        onClick: actions.handlePortConfigAdd,
        disabled: ctx.busy || !activeProfile.protocol,
      },
      {
        icon: 'edit',
        ariaLabel: 'Change port',
        title: 'Change port',
        onClick: actions.handlePortChange,
        disabled: ctx.busy,
      },
    ],
    branch: true,
    open: true,
    children: portChildren,
  })

  // Platforms root
  const platformChildren: TreeNode[] = activeProfile.platforms.map(
    (p, idx) => ({
      id: `platform:${p.platform}:${p.version ?? ''}:${idx}`,
      label: (
        <span className="tree-item__label">
          <span className="tree-item__labelText">
            {ctx.platformNames[p.platform] || p.platform}
          </span>
        </span>
      ),
      description:
        !ctx.platformNames[p.platform] && ctx.unresolvedPlatforms?.[p.platform]
          ? '(not in platform index)' + (p.version ? ` (${p.version})` : '')
          : `${p.platform}` + (p.version ? ` (${p.version})` : ''),
      defaultAction: 'last',
      dataAttrs: {
        'profile-item': `platform:${p.platform}${p.version ? `@${p.version}` : ''}`,
      },
      selected:
        selectedKey ===
        `platform:${p.platform}${p.version ? `@${p.version}` : ''}`,
      actions: [
        {
          icon: 'trash',
          ariaLabel: `Remove platform ${p.platform}`,
          title: 'Remove platform',
          onClick: () => actions.handlePlatformRemove(p),
          disabled: ctx.busy,
        },
        ...(!p.platformIndexUrl
          ? [
              {
                icon: 'link' as const,
                ariaLabel: `Set index URL for ${p.platform}`,
                title: 'Set platform index URL',
                onClick: () => actions.handlePlatformSetIndexUrl(p, false),
                disabled: ctx.busy,
              },
            ]
          : []),
        {
          icon: 'edit',
          ariaLabel: `Change version for ${p.platform}`,
          title: 'Change version',
          onClick: () => actions.handlePlatformEdit(p),
          disabled: ctx.busy,
        },
      ],
      branch: Boolean(p.platformIndexUrl),
      open: Boolean(p.platformIndexUrl),
      children: p.platformIndexUrl
        ? [
            {
              id: `platform-index-url:${p.platform}:${idx}`,
              label: (
                <span className="tree-item__label">
                  <span className="tree-item__labelText">Index URL</span>
                </span>
              ),
              description: String(p.platformIndexUrl),
              defaultAction: 'last',
              dataAttrs: {
                'profile-item': `platform-index-url:${p.platform}`,
              },
              selected: selectedKey === `platform-index-url:${p.platform}`,
              actions: [
                {
                  icon: 'trash',
                  ariaLabel: `Clear index URL for ${p.platform}`,
                  title: 'Clear platform index URL',
                  onClick: () => actions.handlePlatformClearIndexUrl(p, true),
                  disabled: ctx.busy,
                },
                {
                  icon: 'edit',
                  ariaLabel: `Edit index URL for ${p.platform}`,
                  title: 'Edit platform index URL',
                  onClick: () => actions.handlePlatformSetIndexUrl(p, true),
                  disabled: ctx.busy,
                },
              ],
            },
          ]
        : undefined,
    })
  )
  if (!platformChildren.length) {
    platformChildren.push({
      id: 'no-platforms',
      label: '',
      description: 'No platforms added yet',
    })
  }
  items.push({
    id: 'platforms',
    label: (
      <span className="tree-item__label">
        <span className="tree-item__labelText">Platforms</span>
      </span>
    ),
    icon: 'package',
    selected: selectedKey === 'platforms',
    dataAttrs: { 'profile-item': 'platforms' },
    actions: [
      {
        icon: 'plus',
        ariaLabel: 'Add platform',
        title: 'Add platform',
        onClick: actions.handlePlatformAdd,
        disabled: ctx.busy,
      },
    ],
    decoration: (
      <VscodeBadge variant="counter">
        {activeProfile.platforms.length}
      </VscodeBadge>
    ),
    branch: true,
    open: true,
    children: platformChildren,
  })

  // Libraries root
  const libraryChildren: TreeNode[] = activeProfile.libraries.map((l, idx) => ({
    id: `library:${l.library}:${l.version ?? ''}:${idx}`,
    label: (
      <span className="tree-item__label">
        <span className="tree-item__labelText">{l.library}</span>
      </span>
    ),
    description: l.version ? ` (${l.version})` : '',
    defaultAction: 'last',
    dataAttrs: {
      'profile-item': `library:${l.library}${l.version ? `@${l.version}` : ''}`,
    },
    selected:
      selectedKey === `library:${l.library}${l.version ? `@${l.version}` : ''}`,
    actions: [
      {
        icon: 'trash',
        ariaLabel: `Remove library ${l.library}`,
        title: 'Remove library',
        onClick: () => actions.handleLibraryRemove(l),
        disabled: ctx.busy,
      },
      {
        icon: 'edit',
        ariaLabel: `Change version for ${l.library}`,
        title: 'Change version',
        onClick: () => actions.handleLibraryEdit(l),
        disabled: ctx.busy,
      },
    ],
  }))
  if (!libraryChildren.length) {
    libraryChildren.push({
      id: 'no-libraries',
      label: '',
      description: 'No libraries added yet',
    })
  }
  items.push({
    id: 'libraries',
    label: (
      <span className="tree-item__label">
        <span className="tree-item__labelText">Libraries</span>
      </span>
    ),
    icon: 'library',
    selected: selectedKey === 'libraries',
    dataAttrs: { 'profile-item': 'libraries' },
    actions: [
      {
        icon: 'plus',
        ariaLabel: 'Add library',
        title: 'Add library',
        onClick: actions.handleLibraryAdd,
        disabled: ctx.busy,
      },
    ],
    decoration: (
      <VscodeBadge variant="counter">
        {activeProfile.libraries.length}
      </VscodeBadge>
    ),
    branch: true,
    open: true,
    children: libraryChildren,
  })

  return items
}

function buildDraftDetailsTree(
  draft: DraftProfile,
  ctx: {
    busy: boolean
    detectedPorts?: DetectedPorts
    programmerLabel: string
    portLabel: string
    platformNames: Record<string, string>
    portConfigLabels: Record<string, string>
  },
  actions: {
    handleEditBoard: () => void
    handleProgrammerChange: () => void
    handleProgrammerReset: () => void
    handlePortChange: () => void
    handlePortConfigAdd: () => void
    handlePortConfigEdit: (key: string) => void
    handlePortConfigRemove: (key: string) => void
    handleConfigOptionSelect: (option: string) => void
    handleConfigOptionReset: (option: string) => void
    handlePlatformAdd: () => void
    handlePlatformEdit: (p: ProfilePlatformDescriptor) => void
    handlePlatformRemove: (p: ProfilePlatformDescriptor) => void
    handleLibraryAdd: () => void
    handleLibraryEdit: (l: ProfileLibraryDescriptor) => void
    handleLibraryRemove: (l: ProfileLibraryDescriptor) => void
  },
  selectedKey?: string
): TreeNode[] {
  // Delegate to the single builder to avoid duplicated DOM construction
  return buildDetailsTree(
    // adapt DraftProfile to the "active" profile shape used by buildDetailsTree
    {
      name: 'draft',
      fqbn: draft.fqbn,
      programmer: draft.programmer,
      port: draft.port,
      protocol: draft.protocol,
      portConfig: draft.portConfig,
      platforms: draft.platforms,
      libraries: draft.libraries,
    } as any,
    draft.boardDescriptor,
    {
      busy: ctx.busy,
      boardDetailsLoading: false,
      portIdentifier: { address: draft.port, protocol: draft.protocol },
      detectedPorts: ctx.detectedPorts,
      programmerLabel: ctx.programmerLabel,
      platformNames: ctx.platformNames,
      portConfigLabels: ctx.portConfigLabels,
    },
    {
      ...actions,
      canResetConfigOption: (o: {
        selectedValue?: string
        defaultValue?: string
      }) => {
        if (!o?.selectedValue) return false
        if (!o?.defaultValue) return true
        return o.selectedValue !== o.defaultValue
      },
      handlePlatformSetIndexUrl: (p: ProfilePlatformDescriptor) => {
        // For drafts, setting index URL isn't supported yet in UI
      },
      handlePlatformClearIndexUrl: (p: ProfilePlatformDescriptor) => {
        // For drafts, clearing index URL isn't supported yet in UI
      },
    } as any,
    selectedKey
  )
}
