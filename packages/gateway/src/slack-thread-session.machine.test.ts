import { describe, expect, test } from "bun:test";
import { noSession, type SlackThreadRecord } from "./slack-thread-session.context";
import { slackThreadSession as nativeMachine } from "./slack-thread-session.native.machine";
import { slackThreadSession as xstateMachine } from "./slack-thread-session.xstate.machine";

type Snapshot = ReturnType<typeof nativeMachine.getInitialSnapshot>;
type Event = Parameters<typeof nativeMachine.transition>[1];
type Status = Snapshot["value"];

// Both generated modules come from the same .lucy source, and every test runs
// against each, so any difference between them fails a test.
const machines = [
  ["ts-native", nativeMachine],
  ["xstate v6", xstateMachine],
] as const;

const t0 = "2026-01-01T00:00:00.000Z";
const t1 = "2026-01-01T00:01:00.000Z";
const t2 = "2026-01-01T00:30:00.000Z";
const t3 = "2026-01-01T01:00:00.000Z";
const binding = { cwd: "/projects/demo" };

const record: SlackThreadRecord = {
  threadId: "slack:C1:1.000",
  channelId: "C1",
  channelName: "lc-demo",
  threadTs: "1.000",
  createdAt: t0,
  updatedAt: t0,
  lastHumanMessageAt: t0,
};

function at(value: Status, context: Partial<SlackThreadRecord> = {}): Snapshot {
  return {
    status: "active",
    value,
    context: { ...record, ...context },
    output: undefined,
    error: undefined,
  };
}

const activate = (now: string, withBinding?: typeof binding): Event => ({
  type: "ACTIVATE",
  threadId: "slack:C1:1.000",
  channelId: "C1",
  channelName: "lc-renamed",
  threadTs: "1.000",
  binding: withBinding,
  now,
});
const humanReply = (now: string): Event => ({ type: "HUMAN_REPLY", now });
const plan = (now: string): Event => ({
  type: "PLAN",
  plannedSessionId: "planned-1",
  plannedWorkspaceLabel: "[sr] demo thread",
  now,
});
const start = (now: string): Event => ({
  type: "START",
  sessionId: "session-1",
  paneId: "w1:p1",
  workspaceId: "w1",
  now,
});
const settle = (now: string): Event => ({ type: "SETTLE", now });
const resolve = (now: string, quietTimeoutMs = 30 * 60_000): Event => ({
  type: "RESOLVE",
  quietTimeoutMs,
  now,
});
const retire = (now: string): Event => ({ type: "RETIRE", now });

const resolving = at("resolving", { resolvedAt: t1, retireAfter: t2 });

describe.each(machines)("slackThreadSession machine (%s)", (_target, machine) => {
  function send(snapshot: Snapshot, event: Event): Snapshot {
    return machine.transition(snapshot, event)[0];
  }

  test("starts untracked and ignores everything except ACTIVATE", () => {
    const initial = machine.getInitialSnapshot();
    expect(initial.value).toBe("untracked");
    expect(initial.context).toEqual(noSession);
    for (const event of [humanReply(t1), plan(t1), start(t1), settle(t1), resolve(t1), retire(t1)]) {
      expect(send(initial, event)).toBe(initial);
    }
  });

  test("ACTIVATE opens a bound session only when the binding arrives with it", () => {
    const bound = send(machine.getInitialSnapshot(), activate(t1, binding));
    expect(bound.value).toBe("bound");
    expect(bound.context).toMatchObject({ binding, createdAt: t1, lastHumanMessageAt: t1 });

    const neutral = send(machine.getInitialSnapshot(), activate(t1));
    expect(neutral.value).toBe("neutral");
    expect(neutral.context.binding).toBeUndefined();
  });

  test("a thread keeps its first binding, and a binding that arrives mid-turn applies at SETTLE", () => {
    const bound = send(at("neutral"), activate(t1, binding));
    expect(bound.value).toBe("bound");
    expect(bound.context).toMatchObject({ binding, channelName: "lc-renamed", createdAt: t0 });

    const rebound = send(bound, activate(t2, { cwd: "/projects/other" }));
    expect(rebound.value).toBe("bound");
    expect(rebound.context.binding).toEqual(binding);

    const running = send(at("running"), activate(t1, binding));
    expect(running.value).toBe("running");
    expect(send(running, settle(t2)).value).toBe("bound");
  });

  test("SETTLE ends a turn and is ignored outside running", () => {
    const neutral = send(at("running"), settle(t1));
    expect(neutral.value).toBe("neutral");
    expect(neutral.context.updatedAt).toBe(t1);

    for (const status of ["neutral", "bound", "resolving", "retired"] as const) {
      const snapshot = at(status, status === "bound" ? { binding } : {});
      expect(send(snapshot, settle(t1))).toBe(snapshot);
    }
  });

  test("HUMAN_REPLY reopens a resolving thread and only refreshes the others", () => {
    const neutral = send(resolving, humanReply(t1));
    expect(neutral.value).toBe("neutral");
    expect(neutral.context).toMatchObject({ lastHumanMessageAt: t1 });
    expect(neutral.context.resolvedAt).toBeUndefined();
    expect(neutral.context.retireAfter).toBeUndefined();
    expect(send(at("resolving", { binding, retireAfter: t2 }), humanReply(t1)).value).toBe("bound");

    for (const status of ["neutral", "bound", "running"] as const) {
      const next = send(at(status), humanReply(t1));
      expect(next.value).toBe(status);
      expect(next.context.lastHumanMessageAt).toBe(t1);
    }
    const retired = at("retired");
    expect(send(retired, humanReply(t1))).toBe(retired);
  });

  test("PLAN and START record their fields in every live status", () => {
    for (const status of ["neutral", "bound", "running", "resolving"] as const) {
      const planned = send(at(status), plan(t1));
      expect(planned.value).toBe(status);
      expect(planned.context).toMatchObject({ plannedSessionId: "planned-1", updatedAt: t1 });

      const started = send(at(status, { sessionFile: "/old.jsonl" }), start(t1));
      expect(started.value).toBe(status === "resolving" ? "resolving" : "running");
      expect(started.context).toMatchObject({ sessionId: "session-1", paneId: "w1:p1" });
      expect(started.context.sessionFile).toBeUndefined();
    }
    const retired = at("retired");
    expect(send(retired, plan(t1))).toBe(retired);
    expect(send(retired, start(t1))).toBe(retired);
  });

  test("RESOLVE starts the quiet time, and a second RESOLVE restarts it", () => {
    for (const status of ["neutral", "bound", "running"] as const) {
      const next = send(at(status), resolve(t1, 60_000));
      expect(next.value).toBe("resolving");
      expect(next.context).toMatchObject({ resolvedAt: t1, retireAfter: "2026-01-01T00:02:00.000Z" });
    }
    const restarted = send(resolving, resolve(t2, 60_000));
    expect(restarted.value).toBe("resolving");
    expect(restarted.context.retireAfter).toBe("2026-01-01T00:31:00.000Z");

    const retired = at("retired");
    expect(send(retired, resolve(t1))).toBe(retired);
  });

  test("RETIRE waits for the quiet time and is ignored outside resolving", () => {
    expect(send(resolving, retire(t1))).toBe(resolving);
    const atDeadline = send(resolving, retire(t2));
    expect(atDeadline.value).toBe("retired");
    expect(atDeadline.context.updatedAt).toBe(t2);
    expect(send(resolving, retire(t3)).value).toBe("retired");

    for (const status of ["neutral", "bound", "running", "retired"] as const) {
      const snapshot = at(status, { retireAfter: t1 });
      expect(send(snapshot, retire(t3))).toBe(snapshot);
    }
  });

  test("ACTIVATE on a retired thread opens a new session with no leftover fields", () => {
    const old = at("retired", {
      binding,
      sessionId: "session-1",
      paneId: "w1:p1",
      workspaceId: "w1",
      plannedSessionId: "planned-1",
      plannedWorkspaceLabel: "[sr] demo thread",
      resolvedAt: t1,
      retireAfter: t2,
    });
    const next = send(old, activate(t3));
    expect(next.value).toBe("neutral");
    expect({ ...next.context }).toEqual({
      ...record,
      channelName: "lc-renamed",
      createdAt: t3,
      updatedAt: t3,
      lastHumanMessageAt: t3,
    });
  });
});
