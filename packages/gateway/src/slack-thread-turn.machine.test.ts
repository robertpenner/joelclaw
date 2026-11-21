import { describe, expect, test } from "bun:test";
import { noTurn, type SlackThreadTurnRecord } from "./slack-thread-turn.context";
import { slackThreadTurn as nativeMachine } from "./slack-thread-turn.native.machine";
import { slackThreadTurn as xstateMachine } from "./slack-thread-turn.xstate.machine";

type Snapshot = ReturnType<typeof nativeMachine.getInitialSnapshot>;
type Event = Parameters<typeof nativeMachine.transition>[1];
type State = Snapshot["value"];

// Both generated modules come from the same .lucy source, and every test runs
// against each, so any difference between them fails a test.
const machines = [
  ["ts-native", nativeMachine],
  ["xstate v6", xstateMachine],
] as const;

const t0 = "2026-01-01T00:00:00.000Z";
const t1 = "2026-01-01T00:01:00.000Z";

function at(value: State, context: SlackThreadTurnRecord = { sourceEventId: "m1", updatedAt: t0 }): Snapshot {
  return { status: "active", value, context, output: undefined, error: undefined };
}

const claim = (sourceEventId: string): Event => ({ type: "CLAIM", sourceEventId, now: t1 });
const launched = (sourceEventId: string): Event => ({ type: "LAUNCHED", sourceEventId, now: t1 });
const completed = (sourceEventId: string): Event => ({ type: "COMPLETED", sourceEventId, now: t1 });

describe.each(machines)("slackThreadTurn machine (%s)", (_target, machine) => {
  function send(snapshot: Snapshot, event: Event): Snapshot {
    return machine.transition(snapshot, event)[0];
  }

  test("a turn goes claimed, launched, completed, then the next message claims", () => {
    const initial = machine.getInitialSnapshot();
    expect(initial.value).toBe("idle");
    expect(initial.context).toEqual(noTurn);

    const steps: [Event, State][] = [
      [claim("m1"), "claimed"],
      [launched("m1"), "launched"],
      [completed("m1"), "completed"],
      [claim("m2"), "claimed"],
    ];
    let snapshot = initial;
    for (const [event, state] of steps) {
      snapshot = send(snapshot, event);
      expect(snapshot.value).toBe(state);
      expect(snapshot.context).toEqual({ sourceEventId: event.sourceEventId, updatedAt: t1 });
    }
  });

  test("ignores events out of order or for another message", () => {
    const ignored: [State, Event][] = [
      ["idle", launched("m1")],
      ["idle", completed("m1")],
      ["claimed", claim("m2")],
      ["claimed", completed("m1")],
      ["claimed", launched("m2")],
      ["launched", claim("m2")],
      ["launched", launched("m1")],
      ["launched", completed("m2")],
      ["completed", claim("m1")],
      ["completed", launched("m1")],
      ["completed", completed("m1")],
    ];
    for (const [state, event] of ignored) {
      const snapshot = state === "idle" ? machine.getInitialSnapshot() : at(state);
      expect(send(snapshot, event)).toBe(snapshot);
    }
  });
});
