import { EventEmitter } from '@c4312/evt'
import { HOST_EXTENSION } from 'vscode-messenger-common'
import type { Messenger } from 'vscode-messenger-webview'

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
} from '@boardlab/protocol'
import { messengerx } from '@boardlab/base'

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
  toDispose.push(
    messengerx.onNotification(messenger, willInstallPlatform, (event) =>
      onWillInstallEmitter.fire(event)
    )
  )
  toDispose.push(
    messengerx.onNotification(messenger, didInstallPlatform, (event) =>
      onDidInstallEmitter.fire(event)
    )
  )
  toDispose.push(
    messengerx.onNotification(messenger, didErrorInstallPlatform, (event) =>
      onDidErrorInstallEmitter.fire(event)
    )
  )
  toDispose.push(
    messengerx.onNotification(messenger, willUninstallPlatform, (event) =>
      onWillUninstallEmitter.fire(event)
    )
  )
  toDispose.push(
    messengerx.onNotification(messenger, didUninstallPlatform, (event) =>
      onDidUninstallEmitter.fire(event)
    )
  )
  toDispose.push(
    messengerx.onNotification(messenger, didErrorUninstallPlatform, (event) =>
      onDidErrorUninstallEmitter.fire(event)
    )
  )
  toDispose.push(
    messengerx.onNotification(messenger, didUpdatePlatformIndex, () =>
      onDidUpdateIndexEmitter.fire()
    )
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
