import * as vscode from 'vscode'

import { Sketchbooks } from './sketchbooks'
import { isFile, isFolder, isSketch, Resource } from './types'

export class SketchbookView implements vscode.Disposable {
  private _disposable: vscode.Disposable[]
  private readonly treeDataProvider: SketchbookDataProvider

  constructor(context: vscode.ExtensionContext, sketchbooks: Sketchbooks) {
    this._disposable = []
    this.treeDataProvider = new SketchbookDataProvider(context, sketchbooks)
    this._disposable.push(
      vscode.window.createTreeView('boardlab.sketchbook', {
        treeDataProvider: this.treeDataProvider,
        showCollapseAll: true,
      })
    )
  }

  dispose() {
    vscode.Disposable.from(...this._disposable).dispose()
    this._disposable = []
  }
}

class SketchbookDataProvider implements vscode.TreeDataProvider<Resource> {
  private readonly onDidChangeEmitter: vscode.EventEmitter<void>

  constructor(
    context: vscode.ExtensionContext,
    private sketchbooks: Sketchbooks
  ) {
    this.onDidChangeEmitter = new vscode.EventEmitter<void>()
    context.subscriptions.push(
      sketchbooks.onDidChangeSketchFolders(() =>
        this.onDidChangeEmitter.fire()
      ),
      sketchbooks.onDidChangeUserSketchbook(() =>
        this.onDidChangeEmitter.fire()
      )
    )
    context.subscriptions.push(this.onDidChangeEmitter)
  }

  get onDidChangeTreeData(): vscode.Event<void> {
    return this.onDidChangeEmitter.event
  }

  getTreeItem(element: Resource): vscode.TreeItem {
    if (isFile(element)) {
      const item = new vscode.TreeItem(
        element.label,
        vscode.TreeItemCollapsibleState.None
      )
      item.resourceUri = element.uri.with({ scheme: 'file' })
      item.command = {
        command: 'vscode.open',
        title: 'Open Sketch File',
        arguments: [element.uri],
      }
      item.contextValue = 'sketchbookFile'
      return item
    }

    if (isSketch(element)) {
      const item = new vscode.TreeItem(
        element.label,
        vscode.TreeItemCollapsibleState.Collapsed
      )
      item.resourceUri = element.uri
      item.contextValue = 'sketchbookSketch'
      item.tooltip = element.uri.fsPath
      return item
    }

    if (isFolder(element)) {
      const item = new vscode.TreeItem(
        element.uri,
        vscode.TreeItemCollapsibleState.Collapsed
      )
      item.contextValue = 'sketchbookFolder'
      return item
    }

    return new vscode.TreeItem(element.uri)
  }

  async getChildren(element: Resource | undefined): Promise<Resource[]> {
    if (!element) {
      const { userSketchbook } = this.sketchbooks
      return userSketchbook?.children ?? []
    }
    if (isFolder(element) || isSketch(element)) {
      if (!element.children) {
        element.children = await this.sketchbooks.loadChildren(element)
      }
      return element.children ?? []
    }
    return []
  }
}
