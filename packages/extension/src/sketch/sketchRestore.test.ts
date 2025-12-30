import { describe, expect, it, vi } from 'vitest'

import {
  pickRestoreSketchPath,
  restoreCurrentSketch,
  type SketchRestoreState,
} from './sketchRestore'

describe('pickRestoreSketchPath', () => {
  it('prefers the last selected sketch when it is opened', () => {
    const state: SketchRestoreState = {
      lastSelectedSketchPath: '/workspace/foo',
      openedSketchPaths: ['/workspace/foo', '/workspace/bar'],
      resolvedSketchPaths: ['/workspace/bar'],
      isLoading: false,
      isEmpty: false,
    }

    expect(pickRestoreSketchPath(state)).toBe('/workspace/foo')
  })

  it('falls back to the first resolved sketch', () => {
    const state: SketchRestoreState = {
      lastSelectedSketchPath: '/workspace/foo',
      openedSketchPaths: ['/workspace/bar'],
      resolvedSketchPaths: ['/workspace/bar'],
      isLoading: false,
      isEmpty: false,
    }

    expect(pickRestoreSketchPath(state)).toBe('/workspace/bar')
  })

  it('returns undefined when there are no candidates', () => {
    const state: SketchRestoreState = {
      lastSelectedSketchPath: undefined,
      openedSketchPaths: [],
      resolvedSketchPaths: [],
      isLoading: false,
      isEmpty: true,
    }

    expect(pickRestoreSketchPath(state)).toBeUndefined()
  })
})

describe('restoreCurrentSketch', () => {
  it('waits for refresh when loading and empty', async () => {
    let state: SketchRestoreState = {
      lastSelectedSketchPath: undefined,
      openedSketchPaths: [],
      resolvedSketchPaths: [],
      isLoading: true,
      isEmpty: true,
    }
    const updateCurrentSketch = vi.fn(async () => true)
    let onRefreshListener: (() => void) | undefined
    const dispose = vi.fn()

    const restorePromise = restoreCurrentSketch(() => state, {
      updateCurrentSketch,
      onDidRefresh: (listener) => {
        onRefreshListener = listener
        return { dispose }
      },
    })

    expect(updateCurrentSketch).not.toHaveBeenCalled()
    expect(onRefreshListener).toBeDefined()

    state = {
      ...state,
      isLoading: false,
      isEmpty: false,
      resolvedSketchPaths: ['/workspace/new'],
    }

    onRefreshListener?.()
    await restorePromise

    expect(updateCurrentSketch).toHaveBeenCalledWith('/workspace/new')
    expect(dispose).toHaveBeenCalled()
  })

  it('does not register refresh when not loading', async () => {
    const state: SketchRestoreState = {
      lastSelectedSketchPath: undefined,
      openedSketchPaths: [],
      resolvedSketchPaths: [],
      isLoading: false,
      isEmpty: true,
    }
    const updateCurrentSketch = vi.fn(async () => true)
    const onDidRefresh = vi.fn()

    await restoreCurrentSketch(() => state, {
      updateCurrentSketch,
      onDidRefresh,
    })

    expect(onDidRefresh).not.toHaveBeenCalled()
    expect(updateCurrentSketch).not.toHaveBeenCalled()
  })
})
