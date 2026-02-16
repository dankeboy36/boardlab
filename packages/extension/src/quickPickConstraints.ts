export type QuickPickFilter<T> = (candidate: T) => boolean | Promise<boolean>

export interface QuickPickConstraints<T> {
  readonly filters?: ReadonlyArray<QuickPickFilter<T>>
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message
  }
  return String(error)
}

export async function matchesQuickPickConstraints<T>(
  candidate: T,
  constraints?: QuickPickConstraints<T>
): Promise<boolean> {
  for (const filter of constraints?.filters ?? []) {
    try {
      const passed = await filter(candidate)
      if (!passed) {
        return false
      }
    } catch (error) {
      console.warn('Quick pick filter failed', toErrorMessage(error))
      return false
    }
  }

  return true
}

export async function filterQuickPickCandidates<T>(
  candidates: ReadonlyArray<T>,
  constraints?: QuickPickConstraints<T>
): Promise<T[]> {
  const filtered: T[] = []
  for (const candidate of candidates) {
    if (await matchesQuickPickConstraints(candidate, constraints)) {
      filtered.push(candidate)
    }
  }
  return filtered
}
