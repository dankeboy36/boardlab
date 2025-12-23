import { Uri } from 'vscode'

const resourceTypeLiterals = ['folder', 'sketch', 'file'] as const
export type ResourceType = (typeof resourceTypeLiterals)[number]

function isResourceTypeLiteral(arg: unknown): arg is ResourceType {
  return (
    typeof arg === 'string' &&
    resourceTypeLiterals.includes(arg as ResourceType)
  )
}

export interface Resource {
  readonly uri: Uri
  readonly label: string
  readonly type: ResourceType
  children?: Resource[]
}

export function isResource(arg: unknown): arg is Resource {
  return (
    typeof arg === 'object' &&
    arg !== null &&
    (<Resource>arg).uri instanceof Uri &&
    typeof (<Resource>arg).label === 'string' &&
    isResourceTypeLiteral((<Resource>arg).type)
  )
}

export interface Folder extends Resource {
  readonly type: 'folder'
}

export function isFolder(arg: unknown): arg is Folder {
  return isResource(arg) && arg.type === 'folder'
}

export interface Sketch extends Resource {
  readonly type: 'sketch'
  readonly mainSketchFileUri: Uri
}

export function isSketch(arg: unknown): arg is Sketch {
  return isResource(arg) && arg.type === 'sketch'
}

export interface FileResource extends Resource {
  readonly type: 'file'
  readonly isMainSketch?: boolean
}

export function isFile(arg: unknown): arg is FileResource {
  return isResource(arg) && arg.type === 'file'
}

export interface Sketchbook extends Folder {
  /** All sketches contained recursively. */
  readonly sketches: Sketch[]
}
