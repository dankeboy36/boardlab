import type { Disposable } from '@boardlab/protocol'

export interface SketchRestoreState {
  readonly lastSelectedSketchPath?: string
  readonly openedSketchPaths: readonly string[]
  readonly resolvedSketchPaths: readonly string[]
  readonly isLoading: boolean
  readonly isEmpty: boolean
}

export interface SketchRestoreHandlers {
  readonly updateCurrentSketch: (sketchPath: string) => Promise<boolean>
  readonly onDidRefresh: (listener: () => void) => Disposable
}

export function pickRestoreSketchPath(
  state: SketchRestoreState
): string | undefined {
  if (
    state.lastSelectedSketchPath &&
    state.openedSketchPaths.includes(state.lastSelectedSketchPath)
  ) {
    return state.lastSelectedSketchPath
  }
  return state.resolvedSketchPaths[0]
}

export async function restoreCurrentSketch(
  getState: () => SketchRestoreState,
  handlers: SketchRestoreHandlers
): Promise<void> {
  const tryRestore = async (): Promise<boolean> => {
    const state = getState()
    const candidate = pickRestoreSketchPath(state)
    if (!candidate) {
      return false
    }
    return handlers.updateCurrentSketch(candidate)
  }

  const restored = await tryRestore()
  if (restored) {
    return
  }

  const state = getState()
  if (!state.isLoading || !state.isEmpty) {
    return
  }

  const disposable = handlers.onDidRefresh(async () => {
    const refreshed = await tryRestore()
    if (refreshed || !getState().isLoading) {
      disposable.dispose()
    }
  })
}
