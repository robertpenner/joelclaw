/** The Slack message a thread's current turn is answering. */
export type SlackThreadTurnRecord = {
  readonly sourceEventId: string;
  readonly updatedAt: string;
};

/** Every turn event names its source message and carries the host's clock. */
export type TurnEvent = {
  readonly sourceEventId: string;
  readonly now: string;
};

type Args = { readonly context: SlackThreadTurnRecord; readonly event: TurnEvent };

/** The context of `idle`, before the thread's first turn. */
export const noTurn: SlackThreadTurnRecord = { sourceEventId: "", updatedAt: "" };

export function sameTurn({ context, event }: Args): boolean {
  return context.sourceEventId === event.sourceEventId;
}

export function claimTurn({ event }: Args): SlackThreadTurnRecord {
  return { sourceEventId: event.sourceEventId, updatedAt: event.now };
}
