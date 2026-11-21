import type { SlackChannelContextBinding } from "./slack-work-request";

/** Everything the registry records about a Slack thread except its status and turn. */
export type SlackThreadRecord = {
  readonly threadId: string;
  readonly channelId: string;
  readonly channelName: string;
  readonly threadTs: string;
  readonly binding?: SlackChannelContextBinding;
  readonly sessionId?: string;
  readonly sessionFile?: string;
  readonly paneId?: string;
  readonly workspaceId?: string;
  readonly plannedSessionId?: string;
  readonly plannedWorkspaceLabel?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastHumanMessageAt: string;
  readonly resolvedAt?: string;
  readonly retireAfter?: string;
};

/** Every event carries the host's clock reading so the patches stay pure. */
export type Stamped = { readonly now: string };

/**
 * A human message that activates the thread. `binding` is present only when
 * the host has verified that its project directory exists.
 */
export type Activation = Stamped & {
  readonly threadId: string;
  readonly channelId: string;
  readonly channelName: string;
  readonly threadTs: string;
  readonly binding?: SlackChannelContextBinding;
};

export type PlanAttached = Stamped & {
  readonly plannedSessionId: string;
  readonly plannedWorkspaceLabel: string;
};

export type RuntimeAttached = Stamped & {
  readonly sessionId: string;
  readonly sessionFile?: string;
  readonly paneId?: string;
  readonly workspaceId?: string;
};

export type QuietRequested = Stamped & { readonly quietTimeoutMs: number };

type Args<E> = { readonly context: SlackThreadRecord; readonly event: E };
type Patch = Partial<SlackThreadRecord>;

/**
 * The context of `untracked`, before the thread has a session. No stored
 * session is ever untracked: the first `ACTIVATE` replaces every field.
 */
export const noSession: SlackThreadRecord = {
  threadId: "",
  channelId: "",
  channelName: "",
  threadTs: "",
  createdAt: "",
  updatedAt: "",
  lastHumanMessageAt: "",
};

export function arrivesBound({ event }: Args<Activation>): boolean {
  return event.binding !== undefined;
}

export function hasBinding({ context }: Args<Stamped>): boolean {
  return context.binding !== undefined;
}

/** A resolving thread retires once its quiet time has passed. */
export function quietOver({ context, event }: Args<Stamped>): boolean {
  return (
    context.retireAfter !== undefined &&
    !(Date.parse(context.retireAfter) > Date.parse(event.now))
  );
}

/** Starts a new session, clearing everything a retired one left behind. */
export function openSession({ event }: Args<Activation>): Patch {
  return {
    threadId: event.threadId,
    channelId: event.channelId,
    channelName: event.channelName,
    threadTs: event.threadTs,
    binding: event.binding,
    sessionId: undefined,
    sessionFile: undefined,
    paneId: undefined,
    workspaceId: undefined,
    plannedSessionId: undefined,
    plannedWorkspaceLabel: undefined,
    createdAt: event.now,
    updatedAt: event.now,
    lastHumanMessageAt: event.now,
    resolvedAt: undefined,
    retireAfter: undefined,
  };
}

/** A thread keeps its first verified binding. */
export function refreshActivation({ context, event }: Args<Activation>): Patch {
  return {
    channelName: event.channelName,
    binding: context.binding ?? event.binding,
    updatedAt: event.now,
    lastHumanMessageAt: event.now,
  };
}

export function reopen({ event }: Args<Stamped>): Patch {
  return {
    updatedAt: event.now,
    lastHumanMessageAt: event.now,
    resolvedAt: undefined,
    retireAfter: undefined,
  };
}

export function attachPlan({ event }: Args<PlanAttached>): Patch {
  return {
    plannedSessionId: event.plannedSessionId,
    plannedWorkspaceLabel: event.plannedWorkspaceLabel,
    updatedAt: event.now,
  };
}

export function attachRuntime({ event }: Args<RuntimeAttached>): Patch {
  return {
    sessionId: event.sessionId,
    sessionFile: event.sessionFile,
    paneId: event.paneId,
    workspaceId: event.workspaceId,
    updatedAt: event.now,
  };
}

export function beginQuiet({ event }: Args<QuietRequested>): Patch {
  return {
    resolvedAt: event.now,
    retireAfter: new Date(Date.parse(event.now) + event.quietTimeoutMs).toISOString(),
    updatedAt: event.now,
  };
}
