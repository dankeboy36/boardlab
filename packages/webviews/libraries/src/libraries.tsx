import { EventEmitter } from '@c4312/evt'
import { HOST_EXTENSION } from 'vscode-messenger-common'
import type { Messenger } from 'vscode-messenger-webview'

import {
  Disposable,
  ErrorEventParams,
  InstallEventParams,
  Libraries,
  UninstallEventParams,
  busyLibraries,
  didErrorInstallLibrary,
  didErrorUninstallLibrary,
  didInstallLibrary,
  didUninstallLibrary,
  didUpdateLibrariesIndex,
  installLibrary,
  searchLibrary,
  uninstallLibrary,
  willInstallLibrary,
  willUninstallLibrary,
} from '@boardlab/protocol'

import { createLibrariesMock } from './mocks/librariesMock'

export function createLibraries(messenger?: Messenger | undefined): Libraries {
  if (!messenger) {
    return createLibrariesMock()
  }
  const onWillInstallEmitter = new EventEmitter<InstallEventParams>()
  const onDidInstallEmitter = new EventEmitter<InstallEventParams>()
  const onDidErrorInstallEmitter = new EventEmitter<
    InstallEventParams & ErrorEventParams
  >()
  const onWillUninstallEmitter = new EventEmitter<UninstallEventParams>()
  const onDidUninstallEmitter = new EventEmitter<UninstallEventParams>()
  const onDidErrorUninstallEmitter = new EventEmitter<
    UninstallEventParams & ErrorEventParams
  >()
  const onDidUpdateIndexEmitter = new EventEmitter<void>()
  const toDispose: Disposable[] = [
    onWillInstallEmitter,
    onDidInstallEmitter,
    onDidErrorInstallEmitter,
    onWillUninstallEmitter,
    onDidUninstallEmitter,
    onDidErrorUninstallEmitter,
    onDidUpdateIndexEmitter,
  ]
  messenger.onNotification(willInstallLibrary, (event) =>
    onWillInstallEmitter.fire(event)
  )
  messenger.onNotification(didInstallLibrary, (event) =>
    onDidInstallEmitter.fire(event)
  )
  messenger.onNotification(didErrorInstallLibrary, (event) =>
    onDidErrorInstallEmitter.fire(event)
  )
  messenger.onNotification(willUninstallLibrary, (event) =>
    onWillUninstallEmitter.fire(event)
  )
  messenger.onNotification(didUninstallLibrary, (event) =>
    onDidUninstallEmitter.fire(event)
  )
  messenger.onNotification(didErrorUninstallLibrary, (event) =>
    onDidErrorUninstallEmitter.fire(event)
  )
  messenger.onNotification(didUpdateLibrariesIndex, () =>
    onDidUpdateIndexEmitter.fire()
  )
  return {
    busyResources() {
      return messenger.sendRequest(busyLibraries, HOST_EXTENSION)
    },
    search(params, token) {
      return messenger.sendRequest(searchLibrary, HOST_EXTENSION, params, token)
    },
    install(params) {
      return messenger.sendRequest(installLibrary, HOST_EXTENSION, params)
    },
    uninstall(params) {
      return messenger.sendRequest(uninstallLibrary, HOST_EXTENSION, params)
    },
    onWillInstall: onWillInstallEmitter.event,
    onDidInstall: onDidInstallEmitter.event,
    onDidErrorInstall: onDidErrorInstallEmitter.event,
    onWillUninstall: onWillUninstallEmitter.event,
    onDidUninstall: onDidUninstallEmitter.event,
    onDidErrorUninstall: onDidErrorUninstallEmitter.event,
    onDidUpdateIndex: onDidUpdateIndexEmitter.event,
    dispose() {
      let disposable = toDispose.pop()
      while (disposable) {
        try {
          disposable.dispose()
        } catch (e) {
          console.log('Error during disposing resource listeners', e)
        }
        disposable = toDispose.pop()
      }
    },
  }
}
