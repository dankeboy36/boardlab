import type { RequestType } from 'vscode-messenger-common'

export type ExampleSource = 'builtin' | 'platform' | 'library'

export interface ExampleLibrary {
  readonly id: string
  readonly label: string
  readonly source: ExampleSource
  readonly nodes: readonly ExampleTreeNode[]
}

export type ExampleTreeNode =
  | ExampleSketchNode
  | ExampleFolderNode
  | ExampleResourceNode

export interface ExampleSketchNode {
  readonly kind: 'sketch'
  readonly name: string
  readonly relPath: string
  readonly children: readonly ExampleTreeNode[]
}

export interface ExampleFolderNode {
  readonly kind: 'folder'
  readonly name: string
  readonly relPath: string
  readonly children: readonly ExampleTreeNode[]
}

export interface ExampleResourceNode {
  readonly kind: 'resource'
  readonly name: string
  readonly relPath: string
  readonly size: number
}

export interface GetExampleTreeParams {
  readonly exampleId: string
}

export interface OpenExampleReadmeParams {
  readonly exampleId: string
}

export interface OpenExampleSketchParams {
  readonly exampleId: string
  readonly sketchRelPath: string
}

export interface OpenExampleResourceParams {
  readonly exampleId: string
  readonly resourceRelPath: string
}

export interface ListExamplesParams {
  readonly fqbn?: string
}

export const listExamples: RequestType<ListExamplesParams, ExampleLibrary[]> = {
  method: 'arduino.examples.list',
}

export const getExampleTree: RequestType<
  GetExampleTreeParams,
  ExampleTreeNode[]
> = {
  method: 'arduino.examples.getTree',
}

export const openExampleReadme: RequestType<OpenExampleReadmeParams, boolean> =
  {
    method: 'arduino.examples.openReadme',
  }

export const openExampleSketch: RequestType<OpenExampleSketchParams, boolean> =
  {
    method: 'arduino.examples.openSketch',
  }

export const openExampleResource: RequestType<
  OpenExampleResourceParams,
  boolean
> = {
  method: 'arduino.examples.openResource',
}
