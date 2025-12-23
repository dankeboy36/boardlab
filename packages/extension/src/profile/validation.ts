import * as vscode from 'vscode'
import {
  isMap as isYamlMap,
  isScalar as isYamlScalar,
  isSeq as isYamlSeq,
  parseDocument,
} from 'yaml'

export interface ProfilesValidationOptions {
  filePath?: string
}

export function validateProfilesYAML(
  text: string,
  doc: vscode.TextDocument,
  _opts: ProfilesValidationOptions = {},
  rules?: readonly ProfilesRule[]
): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = []
  const ast = parseDocument(text, { logLevel: 'silent' as any })
  for (const err of ast.errors) {
    const [start, end] = err.pos
    const diag = new vscode.Diagnostic(
      offsetToRange(doc, start, end),
      err.message,
      vscode.DiagnosticSeverity.Error
    )
    diag.source = 'boardlab'
    diagnostics.push(diag)
  }
  try {
    const ctx: RuleContext = { vscodeDoc: doc, text, document: ast as any }
    const collected: vscode.Diagnostic[] = []
    const report: Reporter = (
      message,
      target,
      severity = vscode.DiagnosticSeverity.Error,
      options
    ) => {
      const range =
        (options?.preferKey &&
          isYamlPairLike(target) &&
          pairKeyWithColonRange(doc, target)) ||
        nodeRange(doc, target) ||
        new vscode.Range(0, 0, 0, 1)
      const diag = new vscode.Diagnostic(range, message, severity)
      if (options?.code !== undefined) {
        diag.code = options.code
      }
      diag.source = 'boardlab'
      collected.push(diag)
    }
    const activeRules = rules && rules.length ? rules : defaultProfilesRules
    runProfilesRules(ast as any, ctx, activeRules, report)
    diagnostics.push(...collected)
  } catch (err) {
    console.warn('AST validation failed', err)
  }
  return diagnostics
}

export function parseProfilesDocument(text: string): any {
  return parseDocument(text, { logLevel: 'silent' as any }) as any
}

export function findPairByPath(
  document: any,
  path: readonly (string | number)[]
): any | undefined {
  let node: any = document?.contents
  for (let i = 0; i < path.length; i++) {
    const seg = path[i]
    if (typeof seg === 'string') {
      if (!isYamlMap(node)) return undefined
      const pair = (node.items ?? []).find(
        (p: any) => isYamlScalar(p?.key) && String(p.key.value ?? '') === seg
      )
      if (!pair) return undefined
      if (i === path.length - 1) return pair
      node = pair.value
    } else {
      if (!isYamlSeq(node)) return undefined
      node = (node.items ?? [])[seg]
    }
  }
  return undefined
}

export interface VisitEvent {
  readonly node: any
  readonly kind: 'doc' | 'map' | 'seq' | 'pair' | 'scalar'
  readonly parent?: VisitEvent
  readonly path: readonly (string | number)[]
}

export interface RuleContext {
  readonly vscodeDoc: vscode.TextDocument
  readonly text: string
  readonly document: any
}

export interface ReportOptions {
  preferKey?: boolean
  code?: vscode.Diagnostic['code']
}

export type Reporter = (
  message: string,
  target: any,
  severity?: vscode.DiagnosticSeverity,
  options?: ReportOptions
) => void

export interface ProfilesRule {
  onNode?(ev: VisitEvent, ctx: RuleContext, report: Reporter): void
}

const defaultProfilesRules: readonly ProfilesRule[] = [
  { onNode: platformsVersionConsistencyVisitor },
]

function runProfilesRules(
  document: any,
  ctx: RuleContext,
  rules: readonly ProfilesRule[],
  report: Reporter
): void {
  const rootNode = document?.contents
  const root: VisitEvent = { node: rootNode, kind: 'doc', path: [] }
  traverseAst(root, (ev) => {
    for (const rule of rules) rule.onNode?.(ev, ctx, report)
  })
}

function traverseAst(root: VisitEvent, fn: (ev: VisitEvent) => void): void {
  if (!root || !root.node) return
  const node = root.node
  if (isYamlMap(node)) {
    const ev: VisitEvent = {
      node,
      kind: 'map',
      parent: root.kind === 'doc' ? undefined : root,
      path: root.path,
    }
    fn(ev)
    for (const pair of node.items ?? []) {
      const keyText = isYamlScalar(pair.key)
        ? String(pair.key.value ?? '')
        : undefined
      const pairEv: VisitEvent = {
        node: pair,
        kind: 'pair',
        parent: ev,
        path: keyText ? [...ev.path, keyText] : ev.path,
      }
      fn(pairEv)
      const value = pair.value
      if (!value) continue
      if (isYamlMap(value)) {
        traverseAst(
          { node: value, kind: 'map', parent: pairEv, path: pairEv.path },
          fn
        )
      } else if (isYamlSeq(value)) {
        const seqEv: VisitEvent = {
          node: value,
          kind: 'seq',
          parent: pairEv,
          path: pairEv.path,
        }
        fn(seqEv)
        for (let i = 0; i < (value.items ?? []).length; i++) {
          const item: any = value.items[i]
          if (isYamlMap(item)) {
            traverseAst(
              {
                node: item,
                kind: 'map',
                parent: seqEv,
                path: [...seqEv.path, i],
              },
              fn
            )
          } else if (isYamlSeq(item)) {
            traverseAst(
              {
                node: item,
                kind: 'seq',
                parent: seqEv,
                path: [...seqEv.path, i],
              },
              fn
            )
          } else {
            const scalarEv: VisitEvent = {
              node: item,
              kind: 'scalar',
              parent: seqEv,
              path: [...seqEv.path, i],
            }
            fn(scalarEv)
          }
        }
      } else {
        const scalarEv: VisitEvent = {
          node: value,
          kind: 'scalar',
          parent: pairEv,
          path: pairEv.path,
        }
        fn(scalarEv)
      }
    }
  } else if (isYamlSeq(node)) {
    const ev: VisitEvent = {
      node,
      kind: 'seq',
      parent: root.kind === 'doc' ? undefined : root,
      path: root.path,
    }
    fn(ev)
    for (let i = 0; i < (node.items ?? []).length; i++) {
      const item: any = node.items[i]
      if (isYamlMap(item)) {
        traverseAst(
          { node: item, kind: 'map', parent: ev, path: [...ev.path, i] },
          fn
        )
      } else if (isYamlSeq(item)) {
        traverseAst(
          { node: item, kind: 'seq', parent: ev, path: [...ev.path, i] },
          fn
        )
      } else {
        const scalarEv: VisitEvent = {
          node: item,
          kind: 'scalar',
          parent: ev,
          path: [...ev.path, i],
        }
        fn(scalarEv)
      }
    }
  } else {
    fn(root)
  }
}

function platformsVersionConsistencyVisitor(
  ev: VisitEvent,
  _ctx: RuleContext,
  report: Reporter
): void {
  if (ev.kind !== 'pair') return
  const pair = ev.node
  const keyText = isYamlScalar(pair.key)
    ? String(pair.key.value ?? '')
    : undefined
  if (keyText !== 'platforms') return
  const value = pair.value
  if (!value || !isYamlSeq(value)) return
  let hasVersion = false
  let hasNoVersion = false
  for (const item of value.items ?? []) {
    if (isYamlScalar(item)) {
      const v = String((item as any).value ?? '')
      if (extractPlatformVersion(v)) hasVersion = true
      else hasNoVersion = true
    } else if (isYamlMap(item)) {
      const plat = (item.items ?? []).find(
        (p: any) =>
          isYamlScalar(p?.key) && String(p.key.value ?? '') === 'platform'
      )
      const v = isYamlScalar(plat?.value) ? String(plat.value.value ?? '') : ''
      if (extractPlatformVersion(v)) hasVersion = true
      else hasNoVersion = true
    }
  }
  if (hasVersion && hasNoVersion) {
    const profileName = typeof ev.path[1] === 'string' ? ev.path[1] : undefined
    const baseCode = 'boardlab.profiles.clearPlatformVersions'
    const code =
      profileName && profileName.length
        ? `${baseCode}:${profileName}`
        : baseCode
    report(
      'All platforms in a profile must either require a specific version or not',
      pair,
      vscode.DiagnosticSeverity.Error,
      { preferKey: true, code }
    )
  }
}

export function nodeRange(
  doc: vscode.TextDocument,
  node: any
): vscode.Range | undefined {
  const r: [number, number, number] | undefined =
    node?.range ?? node?.key?.range
  if (!r) return undefined
  const [start, valEnd, nodeEnd] = r
  return offsetToRange(doc, start, (valEnd ?? nodeEnd ?? start + 1) as number)
}

export function pairValueRange(
  doc: vscode.TextDocument,
  pair: any
): vscode.Range | undefined {
  const v: any = pair?.value
  const r: [number, number, number] | undefined = v?.range
  if (!r) return undefined
  return offsetToRange(doc, r[0], r[1] ?? r[2] ?? r[0] + 1)
}

export function pairKeyWithColonRange(
  doc: vscode.TextDocument,
  pair: any
): vscode.Range | undefined {
  if (!pair) return undefined
  const key = pair.key
  const start: number | undefined = key?.range?.[0]
  if (typeof start !== 'number') return nodeRange(doc, pair)
  let end: number | undefined = key?.range?.[1] ?? key?.range?.[2]
  const sep = pair?.srcToken?.sep
  const colon = Array.isArray(sep)
    ? sep.find((t: any) => t?.type === 'map-value-ind')
    : undefined
  if (
    colon &&
    typeof colon.offset === 'number' &&
    typeof colon.source === 'string'
  ) {
    end = colon.offset + colon.source.length
  }
  return offsetToRange(doc, start, typeof end === 'number' ? end : start + 1)
}

export function offsetToRange(
  doc: vscode.TextDocument,
  start: number,
  end: number
): vscode.Range {
  const a = doc.positionAt(Math.max(0, start))
  const b = doc.positionAt(Math.max(start, end))
  return new vscode.Range(a, b)
}

function extractPlatformVersion(value: string): string | undefined {
  const match = value.match(/^[^()]+\(([^)]+)\)\s*$/)
  return match ? match[1]?.trim() : undefined
}

function isYamlPairLike(arg: any): arg is { key?: any; value?: any } {
  return !!arg && typeof arg === 'object' && 'key' in arg && 'value' in arg
}
