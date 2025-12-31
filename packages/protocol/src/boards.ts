import type { BoardIdentifier } from 'boards-list'
import { NotificationType, RequestType } from 'vscode-messenger-common'

export type Board = BoardIdentifier

export const getSelectedBoard: RequestType<void, BoardIdentifier | undefined> =
  {
    method: 'arduino.boards.getSelectedBoard',
  }

export const notifyDidChangeSelectedBoard: NotificationType<
  BoardIdentifier | undefined
> = {
  method: 'arduino.boards.didChangeSelectedBoard',
}
