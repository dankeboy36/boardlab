import * as vscode from 'vscode'

import {
  findPairByPath,
  nodeRange,
  pairValueRange,
  parseProfilesDocument,
} from './validation'

export async function buildClearPlatformVersionsEdit(
  doc: vscode.TextDocument,
  profileName: string
): Promise<vscode.WorkspaceEdit | undefined> {
  const text = doc.getText()
  const ydoc = parseProfilesDocument(text)
  const platformsPair = findPairByPath(ydoc, [
    'profiles',
    profileName,
    'platforms',
  ])
  const seq = platformsPair?.value
  if (!seq || !Array.isArray(seq.items)) {
    return undefined
  }

  const edit = new vscode.WorkspaceEdit()
  let changed = false

  for (const entry of seq.items ?? []) {
    if (entry && 'items' in entry) {
      // Map form: { platform: "id (version)", platform_index_url?: ... }
      const platformPair = entry.items?.find(
        (p: any) => p?.key && String(p.key.value ?? '') === 'platform'
      )
      const raw =
        platformPair?.value?.value !== undefined
          ? String(platformPair.value.value)
          : ''
      const m = raw.match(/^([^()]+?)\s*(?:\(([^)]+)\))?\s*$/)
      const id = m?.[1]?.trim()
      if (!id || id === raw.trim()) {
        continue
      }
      const range =
        pairValueRange(doc, platformPair) ||
        (platformPair?.value && nodeRange(doc, platformPair.value)) ||
        nodeRange(doc, platformPair)
      if (!range) {
        continue
      }
      edit.replace(doc.uri, range, id)
      changed = true
    } else if (entry && Object.prototype.hasOwnProperty.call(entry, 'value')) {
      // Scalar form: "id (version)"
      const raw = entry.value !== undefined ? String(entry.value) : ''
      const m = raw.match(/^([^()]+?)\s*(?:\(([^)]+)\))?\s*$/)
      const id = m?.[1]?.trim()
      if (!id || id === raw.trim()) {
        continue
      }
      const range = nodeRange(doc, entry)
      if (!range) {
        continue
      }
      edit.replace(doc.uri, range, id)
      changed = true
    }
  }

  return changed ? edit : undefined
}
