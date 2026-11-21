import { describe, expect, test } from "bun:test";
import { type GatewayAlertRecord, noIncident } from "./gateway-alert-investigator.context";
import { gatewayAlertInvestigator as xstateMachine } from "./gateway-alert-investigator.xstate.machine";
import { gatewayAlertInvestigator as nativeMachine } from "./gateway-alert-investigator.native.machine";

type Snapshot = ReturnType<typeof nativeMachine.getInitialSnapshot>;
type Event = Parameters<typeof nativeMachine.transition>[1];
type Phase = Snapshot["value"];

// Both generated modules come from the same .lucy source, and every test runs
// against each, so any difference between them fails a test.
const machines = [
  ["ts-native", nativeMachine],
  ["xstate v6", xstateMachine],
] as const;

const t0 = "2026-01-01T00:00:00.000Z";
const t1 = "2026-01-01T00:01:00.000Z";
const t2 = "2026-01-01T00:10:00.000Z";

const record: GatewayAlertRecord = {
  incidentId: "11111111-1111-1111-1111-111111111111",
  kind: "missing",
  ageSeconds: 90,
  createdAt: t0,
  updatedAt: t0,
  attempt: 1,
  attemptStartedAt: t0,
  agentName: "gateway_alert_111111111111",
};

function at(value: Phase, context: Partial<GatewayAlertRecord> = {}): Snapshot {
  return {
    status: "active",
    value,
    context: { ...record, ...context },
    output: undefined,
    error: undefined,
  };
}

const alert = (
  now: string,
  incidentId = "22222222-2222-2222-2222-222222222222",
): Extract<Event, { type: "ALERT" }> => ({
  type: "ALERT",
  kind: "stale",
  now,
  incidentId,
});

describe.each(machines)("gatewayAlertInvestigator machine (%s)", (_target, machine) => {
  function send(snapshot: Snapshot, event: Event): Snapshot {
    return machine.transition(snapshot, event)[0];
  }

  test("starts idle with no incident", () => {
    const initial = machine.getInitialSnapshot();
    expect(initial.value).toBe("idle");
    expect(initial.context).toEqual(noIncident);
  });

  test("a new incident after recovery replaces every field of the old one", () => {
    const old = at("recovered", {
      workspaceId: "w1",
      paneId: "p1",
      lastError: "boom",
      recoveredAt: t1,
    });
    const next = send(old, alert(t2));
    expect(next.value).toBe("ensuringHerdr");
    expect(next.context).toEqual({
      incidentId: "22222222-2222-2222-2222-222222222222",
      kind: "stale",
      ageSeconds: undefined,
      createdAt: t2,
      updatedAt: t2,
      attempt: 1,
      attemptStartedAt: t2,
      retryAfter: undefined,
      workspaceId: undefined,
      paneId: undefined,
      agentName: "gateway_alert_222222222222",
      lastError: undefined,
      recoveredAt: undefined,
    });
  });

  test("a repeated alert during a starting step refreshes the alert fields only", () => {
    const next = send(at("openingWorkspace"), { ...alert(t1), ageSeconds: 120 });
    expect(next.value).toBe("openingWorkspace");
    expect(next.context).toEqual({ ...record, kind: "stale", ageSeconds: 120, updatedAt: t1 });
  });

  test("a repeated alert without an age keeps the stored age", () => {
    const next = send(at("startingAgent"), alert(t1));
    expect(next.value).toBe("startingAgent");
    expect(next.context).toEqual({ ...record, kind: "stale", updatedAt: t1 });
  });

  test("each starting step's success moves to the next step and stamps the incident", () => {
    const steps: [Phase, Event, Phase][] = [
      ["ensuringHerdr", { type: "HERDR_READY", now: t1 }, "openingWorkspace"],
      ["startingAgent", { type: "AGENT_READY", now: t1 }, "promptingAgent"],
      ["promptingAgent", { type: "PROMPT_ACCEPTED", now: t1 }, "investigating"],
    ];
    for (const [from, event, to] of steps) {
      const next = send(at(from), event);
      expect(next.value).toBe(to);
      expect(next.context).toEqual({ ...record, updatedAt: t1 });
    }
  });

  test("a lost workspace restarts from Herdr; a lost agent restarts it under a new name", () => {
    const investigating = at("investigating", { workspaceId: "w1", paneId: "p1" });
    const lostWorkspace = send(investigating, { type: "WORKSPACE_LOST", now: t1 });
    expect(lostWorkspace.value).toBe("ensuringHerdr");
    expect(lostWorkspace.context).toEqual({ ...investigating.context, updatedAt: t1 });

    const lostAgent = send(investigating, {
      type: "AGENT_LOST",
      agentName: "gateway_alert_replacement",
      now: t1,
    });
    expect(lostAgent.value).toBe("startingAgent");
    expect(lostAgent.context).toEqual({
      ...investigating.context,
      agentName: "gateway_alert_replacement",
      updatedAt: t1,
    });
  });

  test("a recovery receipt closes the incident; a failed delivery blocks recovery", () => {
    const recovering = at("recovering", { lastError: "earlier" });
    const delivered = send(recovering, { type: "RECOVERY_DELIVERED", recoveredAt: t1, now: t2 });
    expect(delivered.value).toBe("recovered");
    expect(delivered.context).toEqual({
      ...record,
      updatedAt: t2,
      recoveredAt: t1,
      lastError: undefined,
    });

    const failed = send(recovering, { type: "RECOVERY_FAILED", error: "prompt failed", now: t1 });
    expect(failed.value).toBe("recoveryBlocked");
    expect(failed.context).toEqual({ ...record, updatedAt: t1, lastError: "prompt failed" });
  });

  test("an alert during or after a failed recovery starts the next attempt of the same incident", () => {
    for (const phase of ["recovering", "recoveryBlocked"] as const) {
      const next = send(at(phase, { workspaceId: "w1", lastError: "prompt failed" }), alert(t2));
      expect(next.value).toBe("ensuringHerdr");
      expect(next.context).toEqual({
        ...record,
        kind: "stale",
        updatedAt: t2,
        attempt: 2,
        attemptStartedAt: t2,
        retryAfter: undefined,
        workspaceId: "w1",
        lastError: undefined,
      });
    }
  });

  test("recovery from blocked clears the back-off window", () => {
    const next = send(at("blocked", { retryAfter: t2, lastError: "boom" }), {
      type: "BEGIN_RECOVERY",
      now: t1,
    });
    expect(next.value).toBe("recovering");
    expect(next.context).toEqual({
      ...record,
      updatedAt: t1,
      retryAfter: undefined,
      lastError: undefined,
    });
  });

  test("a blocked incident with no retry time retries on the next alert", () => {
    expect(send(at("blocked"), alert(t1)).value).toBe("ensuringHerdr");
  });

  test("an alert inside the back-off window leaves a blocked incident untouched", () => {
    const blocked = at("blocked", { retryAfter: t2, lastError: "boom" });
    expect(send(blocked, alert(t1))).toBe(blocked);
  });

  test("an alert after the back-off window starts the next attempt", () => {
    const blocked = at("blocked", { retryAfter: t1, lastError: "boom" });
    const next = send(blocked, alert(t2));
    expect(next.value).toBe("ensuringHerdr");
    expect(next.context).toMatchObject({
      incidentId: record.incidentId,
      attempt: 2,
      attemptStartedAt: t2,
      retryAfter: undefined,
      lastError: undefined,
    });
  });

  test("a failure blocks until the attempt start plus the retry delay", () => {
    const next = send(at("startingAgent", { attemptStartedAt: t0 }), {
      type: "FAILED",
      error: "model unavailable",
      retryMs: 60_000,
      now: t2,
    });
    expect(next.value).toBe("blocked");
    expect(next.context).toMatchObject({ retryAfter: t1, lastError: "model unavailable" });
  });

  test("a replacement workspace gets a new agent name; the first workspace keeps it", () => {
    const ready = (created: boolean): Event => ({
      type: "WORKSPACE_READY",
      workspaceId: "w2",
      paneId: "p2",
      created,
      replacementAgentName: "gateway_alert_replacement",
      now: t1,
    });
    expect(send(at("openingWorkspace"), ready(true)).context.agentName).toBe(record.agentName);
    expect(
      send(at("openingWorkspace", { workspaceId: "w1" }), ready(true)).context.agentName,
    ).toBe("gateway_alert_replacement");
    expect(send(at("recovering", { workspaceId: "w1" }), ready(false)).context).toMatchObject({
      workspaceId: "w2",
      agentName: record.agentName,
    });
  });

  test("recovery retries from recoveryBlocked through the same event", () => {
    const next = send(at("recoveryBlocked", { lastError: "rename failed" }), {
      type: "BEGIN_RECOVERY",
      now: t1,
    });
    expect(next.value).toBe("recovering");
    expect(next.context.lastError).toBeUndefined();
  });

  test("an event the current state does not handle changes nothing", () => {
    const cases: [Phase, Event][] = [
      ["idle", { type: "BEGIN_RECOVERY", now: t1 }],
      ["recovered", { type: "BEGIN_RECOVERY", now: t1 }],
      ["recovering", { type: "BEGIN_RECOVERY", now: t1 }],
      ["idle", { type: "PROMPT_ACCEPTED", now: t1 }],
      ["investigating", { type: "FAILED", error: "x", retryMs: 1, now: t1 }],
    ];
    for (const [phase, event] of cases) {
      const snapshot = at(phase);
      expect(send(snapshot, event)).toBe(snapshot);
    }
  });
});
