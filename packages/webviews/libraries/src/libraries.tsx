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
import { messengerx } from '@boardlab/base'

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
  toDispose.push(
    messengerx.onNotification(messenger, willInstallLibrary, (event) =>
      onWillInstallEmitter.fire(event)
    )
  )
  toDispose.push(
    messengerx.onNotification(messenger, didInstallLibrary, (event) =>
      onDidInstallEmitter.fire(event)
    )
  )
  toDispose.push(
    messengerx.onNotification(messenger, didErrorInstallLibrary, (event) =>
      onDidErrorInstallEmitter.fire(event)
    )
  )
  toDispose.push(
    messengerx.onNotification(messenger, willUninstallLibrary, (event) =>
      onWillUninstallEmitter.fire(event)
    )
  )
  toDispose.push(
    messengerx.onNotification(messenger, didUninstallLibrary, (event) =>
      onDidUninstallEmitter.fire(event)
    )
  )
  toDispose.push(
    messengerx.onNotification(messenger, didErrorUninstallLibrary, (event) =>
      onDidErrorUninstallEmitter.fire(event)
    )
  )
  toDispose.push(
    messengerx.onNotification(messenger, didUpdateLibrariesIndex, () =>
      onDidUpdateIndexEmitter.fire()
    )
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
