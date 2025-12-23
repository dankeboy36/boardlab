import { promises as fs } from 'node:fs'
import * as path from 'node:path'

import { MonitorPortSettingDescriptor } from 'ardunno-cli/api'
import { FQBN } from 'fqbn'
import { ClientError } from 'nice-grpc-common'
import * as vscode from 'vscode'

import type { ArdunnoContextImpl } from '../ardunnoContext'
import { LibrariesManager, PlatformsManager } from '../resourcesManager'
import {
  findPairByPath,
  nodeRange,
  pairValueRange,
  parseProfilesDocument,
} from './validation'

/**
 * Collect CLI-enriched diagnostics (FQBN, platforms, libraries, port config)
 * for all profiles in the given YAML text. Returns an empty array on errors.
 */
export async function collectCliDiagnostics(
  ardunnoContext: ArdunnoContextImpl,
  doc: vscode.TextDocument,
  text: string
): Promise<vscode.Diagnostic[]> {
  try {
    const ydoc = parseProfilesDocument(text)
    const diagnostics: vscode.Diagnostic[] = []

    const profilesPair = findPairByPath(ydoc, ['profiles'])
    const profilesMap = profilesPair?.value
    if (!profilesMap || !('items' in profilesMap)) return diagnostics

    for (const profilePair of profilesMap.items ?? []) {
      const profileName = String(profilePair?.key?.value ?? '')
      const profileMap = profilePair?.value
      if (!profileMap || !('items' in profileMap)) continue

      const [fqbnIssues, platformIssues, librariesIssues, portConfigIssues] =
        await Promise.all([
          validateProfileFqbn(ardunnoContext, doc, ydoc, profileName),
          validateProfilePlatforms(
            ardunnoContext.platformsManager,
            doc,
            ydoc,
            profileName
          ),
          validateProfileLibraries(
            ardunnoContext.librariesManager,
            doc,
            ydoc,
            profileName
          ),
          validateProfilePortConfig(ardunnoContext, doc, ydoc, profileName),
        ])

      diagnostics.push(
        ...fqbnIssues,
        ...platformIssues,
        ...librariesIssues,
        ...portConfigIssues
      )
    }

    // Order diagnostics: severity, then position, then alphabetically by message
    diagnostics.sort((a, b) => {
      const sa = a.severity ?? vscode.DiagnosticSeverity.Information
      const sb = b.severity ?? vscode.DiagnosticSeverity.Information
      if (sa !== sb) return sa - sb
      const oa = doc.offsetAt(a.range.start)
      const ob = doc.offsetAt(b.range.start)
      if (oa !== ob) return oa - ob
      const ma = a.message || ''
      const mb = b.message || ''
      return ma.localeCompare(mb)
    })

    return diagnostics
  } catch {
    return []
  }
}

async function validateProfileFqbn(
  ardunnoContext: ArdunnoContextImpl,
  doc: vscode.TextDocument,
  ydoc: any,
  profileName: string
): Promise<vscode.Diagnostic[]> {
  const diags: vscode.Diagnostic[] = []
  const fqbnPair = findPairByPath(ydoc, ['profiles', profileName, 'fqbn'])
  const fqbnValue = String(fqbnPair?.value?.value ?? '')
  if (!fqbnPair || !fqbnValue) return diags
  let parsed: FQBN | undefined
  try {
    parsed = new FQBN(fqbnValue)
  } catch {
    diags.push(
      new vscode.Diagnostic(
        pairValueRange(doc, fqbnPair) ?? new vscode.Range(0, 0, 0, 1),
        'Invalid FQBN format',
        vscode.DiagnosticSeverity.Error
      )
    )
    return diags
  }
  try {
    const details = await ardunnoContext.getBoardDetails(parsed)
    const options = parsed.options ?? {}
    for (const [k, v] of Object.entries(options)) {
      const opt = details.configOptions.find((o: any) => o.option === k)
      if (!opt) {
        diags.push(
          new vscode.Diagnostic(
            pairValueRange(doc, fqbnPair) ?? new vscode.Range(0, 0, 0, 1),
            `Unknown board option '${k}' in FQBN`,
            vscode.DiagnosticSeverity.Error
          )
        )
        continue
      }
      const allowed = opt.values?.map((vv: any) => vv.value) ?? []
      if (!allowed.includes(v)) {
        diags.push(
          new vscode.Diagnostic(
            pairValueRange(doc, fqbnPair) ?? new vscode.Range(0, 0, 0, 1),
            `Invalid value '${v}' for board option '${k}'`,
            vscode.DiagnosticSeverity.Error
          )
        )
      }
    }
  } catch (err) {
    const message =
      err instanceof ClientError
        ? err.details || err.message
        : (err as any)?.message || 'Unknown FQBN error'
    diags.push(
      new vscode.Diagnostic(
        pairValueRange(doc, fqbnPair) ?? new vscode.Range(0, 0, 0, 1),
        message,
        vscode.DiagnosticSeverity.Error
      )
    )
  }
  return diags
}

async function validateProfilePortConfig(
  ardunnoContext: ArdunnoContextImpl,
  doc: vscode.TextDocument,
  ydoc: any,
  profileName: string
): Promise<vscode.Diagnostic[]> {
  const diags: vscode.Diagnostic[] = []

  const protocolPair = findPairByPath(ydoc, [
    'profiles',
    profileName,
    'protocol',
  ])
  const fqbnPair = findPairByPath(ydoc, ['profiles', profileName, 'fqbn'])
  const portConfigPair = findPairByPath(ydoc, [
    'profiles',
    profileName,
    'port_config',
  ])
  if (
    !portConfigPair ||
    !portConfigPair.value ||
    !('items' in portConfigPair.value)
  ) {
    return diags
  }

  let protocol = String(protocolPair?.value?.value ?? '').trim()
  const fqbn = String(fqbnPair?.value?.value ?? '').trim() || undefined
  // Infer default 'serial' protocol if not explicitly set
  if (!protocol) protocol = 'serial'

  let settings: MonitorPortSettingDescriptor[] = []
  try {
    settings = await ardunnoContext.getPortSettingsForProtocol(protocol, fqbn)
  } catch (err) {
    // If enumeration fails, surface a generic warning and skip details
    diags.push(
      new vscode.Diagnostic(
        nodeRange(doc, portConfigPair.key) ||
          nodeRange(doc, portConfigPair) ||
          new vscode.Range(0, 0, 0, 1),
        `Unable to enumerate port settings for protocol "${protocol}"`,
        vscode.DiagnosticSeverity.Warning
      )
    )
    return diags
  }

  const byId = new Map<string, any>()
  for (const s of settings || []) {
    const id = String(s?.settingId ?? '')
    if (id) byId.set(id, s)
  }

  for (const item of portConfigPair.value.items ?? []) {
    const keyNode = item?.key
    const valNode = item?.value
    const keyText = keyNode?.value !== undefined ? String(keyNode.value) : ''
    if (!keyText) {
      continue
    }
    const desc = byId.get(keyText)
    if (!desc) {
      diags.push(
        new vscode.Diagnostic(
          nodeRange(doc, keyNode) ||
            nodeRange(doc, item) ||
            new vscode.Range(0, 0, 0, 1),
          `Setting "${keyText}" is not available for protocol "${protocol}"`,
          vscode.DiagnosticSeverity.Error
        )
      )
      continue
    }
    const enumValues: string[] = Array.isArray(desc?.enumValues)
      ? (desc.enumValues as string[])
      : []
    if (enumValues.length) {
      const rawValue = valNode?.value !== undefined ? String(valNode.value) : ''
      if (!enumValues.includes(rawValue)) {
        diags.push(
          new vscode.Diagnostic(
            nodeRange(doc, valNode) ||
              nodeRange(doc, item) ||
              new vscode.Range(0, 0, 0, 1),
            `Invalid value "${rawValue}" for port setting "${keyText}"`,
            vscode.DiagnosticSeverity.Error
          )
        )
      }
    }
  }

  return diags
}

async function validateProfilePlatforms(
  manager: PlatformsManager,
  doc: vscode.TextDocument,
  ydoc: any,
  profileName: string
): Promise<vscode.Diagnostic[]> {
  const diags: vscode.Diagnostic[] = []
  const platformsPair = findPairByPath(ydoc, [
    'profiles',
    profileName,
    'platforms',
  ])
  const seq = platformsPair?.value
  if (!seq || !Array.isArray(seq.items)) return diags

  for (const entry of seq.items) {
    let id: string | undefined
    let version: string | undefined
    let indexUrl: string | undefined
    let entryRange: vscode.Range | undefined

    if (entry && 'items' in entry) {
      const p = entry.items?.find(
        (pp: any) => pp?.key && String(pp.key.value ?? '') === 'platform'
      )
      const u = entry.items?.find(
        (pp: any) =>
          pp?.key && String(pp.key.value ?? '') === 'platform_index_url'
      )
      const text = p?.value?.value ? String(p.value.value) : undefined
      if (text) {
        const m = text.match(/^([^()]+?)\s*(?:\(([^)]+)\))?\s*$/)
        id = m?.[1]?.trim()
        version = m?.[2]?.trim()
      }
      indexUrl = u?.value?.value ? String(u.value.value) : undefined
      entryRange = (p && pairValueRange(doc, p)) || nodeRange(doc, p)
    } else {
      const text = entry?.value !== undefined ? String(entry.value) : undefined
      if (text) {
        const m = text.match(/^([^()]+?)\s*(?:\(([^)]+)\))?\s*$/)
        id = m?.[1]?.trim()
        version = m?.[2]?.trim()
      }
      entryRange = nodeRange(doc, entry)
    }
    if (!id) continue

    try {
      const match = await manager.lookupPlatformQuick(id)
      if (!match) {
        const diag = new vscode.Diagnostic(
          entryRange ?? new vscode.Range(0, 0, 0, 1),
          indexUrl
            ? `Platform '${id}' not found in any known index; profile declares platform_index_url: ${indexUrl}`
            : `Platform '${id}' not found in any known index`,
          vscode.DiagnosticSeverity.Error
        )
        diag.source = 'ardunno'
        if (indexUrl) {
          // If the profile provides a custom index URL, surface a quick fix
          // that opens the Arduino CLI configuration so the user can add it
          // to board_manager.additional_urls.
          diag.code = 'missingPlatformIndexUrl'
        }
        diags.push(diag)
      } else {
        if (version && !match.availableVersions.includes(version)) {
          const diag = new vscode.Diagnostic(
            entryRange ?? new vscode.Range(0, 0, 0, 1),
            `Platform '${id}' has no release '${version}'`,
            vscode.DiagnosticSeverity.Error
          )
          diag.source = 'ardunno'
          // Quick fixes: use installed/latest/select version for this platform.
          diag.code = 'invalidPlatformVersion'
          diags.push(diag)
        } else if (version && match.installedVersion !== version) {
          const label = match.label ?? id
          const installed = match.installedVersion
          if (!installed) {
            const diag = new vscode.Diagnostic(
              entryRange ?? new vscode.Range(0, 0, 0, 1),
              `Platform '${label}' [${id}] version '${version}' is not installed`,
              vscode.DiagnosticSeverity.Warning
            )
            diag.source = 'ardunno'
            diag.code = 'missingPlatformVersion'
            diags.push(diag)
          } else {
            const diag = new vscode.Diagnostic(
              entryRange ?? new vscode.Range(0, 0, 0, 1),
              `Platform '${label}' [${id}] installed '${installed}' but profile requires '${version}'`,
              vscode.DiagnosticSeverity.Warning
            )
            diag.source = 'ardunno'
            diag.code = 'missingPlatformVersion'
            diags.push(diag)
          }
        }
        if (!match.installedVersion && !version) {
          const label = match.label ?? id
          const diag = new vscode.Diagnostic(
            entryRange ?? new vscode.Range(0, 0, 0, 1),
            `Platform '${label}' [${id}] is not installed`,
            vscode.DiagnosticSeverity.Warning
          )
          diag.source = 'ardunno'
          diag.code = 'missingPlatform'
          diags.push(diag)
        }
      }
    } catch {}

    if (indexUrl) {
      const ok = /^(https?:|git(?::|\+https?:))/i.test(indexUrl.trim())
      if (!ok) {
        const diag = new vscode.Diagnostic(
          entryRange ?? new vscode.Range(0, 0, 0, 1),
          `Invalid platform_index_url scheme: ${indexUrl}`,
          vscode.DiagnosticSeverity.Error
        )
        diag.source = 'ardunno'
        diags.push(diag)
      }
    }
  }

  return diags
}

async function validateProfileLibraries(
  manager: LibrariesManager,
  doc: vscode.TextDocument,
  ydoc: any,
  profileName: string
): Promise<vscode.Diagnostic[]> {
  const diags: vscode.Diagnostic[] = []
  const libsPair = findPairByPath(ydoc, ['profiles', profileName, 'libraries'])
  const libsSeq = libsPair?.value
  if (!libsSeq || !Array.isArray(libsSeq.items)) return diags

  for (const item of libsSeq.items) {
    // Map form: { dir: "./path" }
    if (item && 'items' in item) {
      const dirPair = item.items?.find(
        (p: any) => p?.key && String(p.key.value ?? '') === 'dir'
      )
      const raw = dirPair?.value?.value ? String(dirPair.value.value) : ''
      const entryRange =
        (dirPair && pairValueRange(doc, dirPair)) ||
        nodeRange(doc, dirPair) ||
        nodeRange(doc, item)
      if (!raw) continue
      try {
        const base = path.dirname(doc.uri.fsPath)
        const abs = path.isAbsolute(raw) ? raw : path.resolve(base, raw)
        const stat = await fs.stat(abs)
        if (!stat.isDirectory()) {
          const diag = new vscode.Diagnostic(
            entryRange ?? new vscode.Range(0, 0, 0, 1),
            `Library dir is not a directory: ${raw}`,
            vscode.DiagnosticSeverity.Warning
          )
          diag.source = 'ardunno'
          diags.push(diag)
        }
      } catch {
        const diag = new vscode.Diagnostic(
          entryRange ?? new vscode.Range(0, 0, 0, 1),
          `Library dir not found: ${raw}`,
          vscode.DiagnosticSeverity.Warning
        )
        diag.source = 'ardunno'
        diags.push(diag)
      }
    } else if (item && Object.prototype.hasOwnProperty.call(item, 'value')) {
      // Scalar form: "Name (Version)"
      const str = String(item.value ?? '')
      const entryRange = nodeRange(doc, item)
      const m = str.match(/^([^()]+?)\s*\(([^)]+)\)\s*$/)
      if (!m) {
        const diag = new vscode.Diagnostic(
          entryRange ?? new vscode.Range(0, 0, 0, 1),
          `Invalid library directive: ${str}`,
          vscode.DiagnosticSeverity.Error
        )
        diag.source = 'ardunno'
        // Quick fixes: normalize to "Name (version)" using installed/latest/picked version.
        diag.code = 'invalidLibraryDirective'
        diags.push(diag)
      } else {
        const name = m[1].trim()
        const ver = m[2].trim()
        try {
          const match = await manager.lookupLibraryQuick(name)
          if (!match) {
            const diag = new vscode.Diagnostic(
              entryRange ?? new vscode.Range(0, 0, 0, 1),
              `Library '${name}' not found`,
              vscode.DiagnosticSeverity.Error
            )
            diag.source = 'ardunno'
            diags.push(diag)
          } else {
            const versions = match.availableVersions
            if (!versions.includes(ver)) {
              const diag = new vscode.Diagnostic(
                entryRange ?? new vscode.Range(0, 0, 0, 1),
                `Library '${name}' has no release '${ver}'`,
                vscode.DiagnosticSeverity.Error
              )
              diag.source = 'ardunno'
              // Quick fixes: use installed/latest/select version
              diag.code = 'invalidLibraryVersion'
              diags.push(diag)
            } else if (!match.installedVersion) {
              const label = match.label ?? name
              const diag = new vscode.Diagnostic(
                entryRange ?? new vscode.Range(0, 0, 0, 1),
                `Library '${label}' version '${ver}' is not installed`,
                vscode.DiagnosticSeverity.Warning
              )
              diag.source = 'ardunno'
              diag.code = 'missingLibrary'
              diags.push(diag)
            } else if (match.installedVersion !== ver) {
              const label = match.label ?? name
              const diag = new vscode.Diagnostic(
                entryRange ?? new vscode.Range(0, 0, 0, 1),
                `Library '${label}' installed '${match.installedVersion}' but profile requires '${ver}'`,
                vscode.DiagnosticSeverity.Warning
              )
              diag.source = 'ardunno'
              diag.code = 'missingLibrary'
              diags.push(diag)
            }
          }
        } catch {}
      }
    }
  }

  return diags
}
