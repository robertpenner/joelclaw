export type GatewayAlertKind = "missing" | "stale";

/** Everything the investigator records about an incident except its phase. */
export type GatewayAlertRecord = {
  readonly incidentId: string;
  readonly kind: GatewayAlertKind;
  readonly ageSeconds?: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly attempt: number;
  readonly attemptStartedAt: string;
  readonly retryAfter?: string;
  readonly workspaceId?: string;
  readonly paneId?: string;
  readonly agentName?: string;
  readonly lastError?: string;
  readonly recoveredAt?: string;
};

/** Every event carries the host's clock reading so the patches stay pure. */
export type Stamped = { readonly now: string };

/**
 * A tripwire alert. `incidentId` names the incident that opens if none is
 * active; the machine ignores it otherwise.
 */
export type AlertReceived = Stamped & {
  readonly kind: GatewayAlertKind;
  readonly ageSeconds?: number;
  readonly incidentId: string;
};

/**
 * `replacementAgentName` is used only when Herdr created a new workspace for
 * an incident that already had one, because the old agent died with it.
 */
export type WorkspaceReady = Stamped & {
  readonly workspaceId: string;
  readonly paneId: string;
  readonly created: boolean;
  readonly replacementAgentName: string;
};

export type AgentReplaced = Stamped & { readonly agentName: string };
export type AttemptFailed = Stamped & { readonly error: string; readonly retryMs: number };
export type RecoveryDelivered = Stamped & { readonly recoveredAt: string };
export type RecoveryFailed = Stamped & { readonly error: string };

type Args<E> = { readonly context: GatewayAlertRecord; readonly event: E };
type Patch = Partial<GatewayAlertRecord>;

/**
 * The context of `idle`, before any incident exists. No stored incident is
 * ever idle: the first `ALERT` replaces every field.
 */
export const noIncident: GatewayAlertRecord = {
  incidentId: "",
  kind: "missing",
  createdAt: "",
  updatedAt: "",
  attempt: 0,
  attemptStartedAt: "",
};

export function incidentName(incidentId: string): string {
  return `gateway_alert_${incidentId.replaceAll("-", "").slice(0, 12)}`;
}

function alertFields(event: AlertReceived): Patch {
  return {
    kind: event.kind,
    ...(event.ageSeconds === undefined ? {} : { ageSeconds: event.ageSeconds }),
    updatedAt: event.now,
  };
}

/** A blocked incident may retry once its back-off window has passed. */
export function retryDue({ context, event }: Args<AlertReceived>): boolean {
  const retryAt = context.retryAfter ? Date.parse(context.retryAfter) : 0;
  return !(retryAt > Date.parse(event.now));
}

export function openIncident({ event }: Args<AlertReceived>): Patch {
  return {
    incidentId: event.incidentId,
    kind: event.kind,
    ageSeconds: event.ageSeconds,
    createdAt: event.now,
    updatedAt: event.now,
    attempt: 1,
    attemptStartedAt: event.now,
    retryAfter: undefined,
    workspaceId: undefined,
    paneId: undefined,
    agentName: incidentName(event.incidentId),
    lastError: undefined,
    recoveredAt: undefined,
  };
}

export function refreshAlert({ event }: Args<AlertReceived>): Patch {
  return alertFields(event);
}

export function restartAttempt({ context, event }: Args<AlertReceived>): Patch {
  return {
    ...alertFields(event),
    attempt: context.attempt + 1,
    attemptStartedAt: event.now,
    retryAfter: undefined,
    lastError: undefined,
  };
}

export function recordWorkspace({ context, event }: Args<WorkspaceReady>): Patch {
  return {
    workspaceId: event.workspaceId,
    paneId: event.paneId,
    ...(event.created && context.workspaceId ? { agentName: event.replacementAgentName } : {}),
    updatedAt: event.now,
  };
}

export function failAttempt({ context, event }: Args<AttemptFailed>): Patch {
  return {
    updatedAt: event.now,
    retryAfter: new Date(Date.parse(context.attemptStartedAt) + event.retryMs).toISOString(),
    lastError: event.error,
  };
}

export function beginRecovery({ event }: Args<Stamped>): Patch {
  return { updatedAt: event.now, retryAfter: undefined, lastError: undefined };
}

export function recordRecovery({ event }: Args<RecoveryDelivered>): Patch {
  return { updatedAt: event.now, recoveredAt: event.recoveredAt, lastError: undefined };
}
