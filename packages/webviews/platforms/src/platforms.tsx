import { EventEmitter } from '@c4312/evt'
import {
  Disposable,
  ErrorEventParams,
  InstallEventParams,
  Platforms,
  UninstallEventParams,
  busyPlatforms,
  didErrorInstallPlatform,
  didErrorUninstallPlatform,
  didInstallPlatform,
  didUninstallPlatform,
  didUpdatePlatformIndex,
  installPlatform,
  searchPlatform,
  uninstallPlatform,
  willInstallPlatform,
  willUninstallPlatform,
} from '@vscode-ardunno/protocol'
import { HOST_EXTENSION } from 'vscode-messenger-common'
import type { Messenger } from 'vscode-messenger-webview'

import { createPlatformsMock } from './mocks/platformsMock'

export function createPlatforms(messenger?: Messenger | undefined): Platforms {
  if (!messenger) {
    return createPlatformsMock()
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
  messenger.onNotification(willInstallPlatform, (event) =>
    onWillInstallEmitter.fire(event)
  )
  messenger.onNotification(didInstallPlatform, (event) =>
    onDidInstallEmitter.fire(event)
  )
  messenger.onNotification(didErrorInstallPlatform, (event) =>
    onDidErrorInstallEmitter.fire(event)
  )
  messenger.onNotification(willUninstallPlatform, (event) =>
    onWillUninstallEmitter.fire(event)
  )
  messenger.onNotification(didUninstallPlatform, (event) =>
    onDidUninstallEmitter.fire(event)
  )
  messenger.onNotification(didErrorUninstallPlatform, (event) =>
    onDidErrorUninstallEmitter.fire(event)
  )
  messenger.onNotification(didUpdatePlatformIndex, () =>
    onDidUpdateIndexEmitter.fire()
  )
  return {
    busyResources() {
      return messenger.sendRequest(busyPlatforms, HOST_EXTENSION)
    },
    search(params) {
      return messenger.sendRequest(searchPlatform, HOST_EXTENSION, params)
    },
    install(params) {
      return messenger.sendRequest(installPlatform, HOST_EXTENSION, params)
    },
    uninstall(params) {
      return messenger.sendRequest(uninstallPlatform, HOST_EXTENSION, params)
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
