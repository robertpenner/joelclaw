import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlackThreadSessionRegistry } from "./slack-thread-session";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function harness(now = new Date("2026-08-12T16:00:00.000Z")) {
  const root = join(tmpdir(), `slack-thread-session-${crypto.randomUUID()}`);
  roots.push(root);
  await mkdir(join(root, ".brain/projects/demo"), { recursive: true });
  await writeFile(join(root, ".brain/projects/demo/brief.svx"), "# Demo\n");
  let clock = now;
  const registry = new SlackThreadSessionRegistry(
    join(root, "sessions.json"),
    () => clock,
  );
  return {
    root,
    registry,
    setNow(value: Date) {
      clock = value;
    },
  };
}

describe("SlackThreadSessionRegistry", () => {
  test("activates a verified binding and survives registry reconstruction", async () => {
    const tested = await harness();
    const activated = await tested.registry.activate({
      channelId: "C1",
      channelName: "lc-demo",
      threadTs: "1.000",
      binding: {
        cwd: tested.root,
        brainEntry: ".brain/projects/demo/brief.svx",
      },
    });
    expect(activated.status).toBe("bound");

    await tested.registry.attachRuntime({
      channelId: "C1",
      threadTs: "1.000",
      sessionId: "session-1",
      paneId: "w1:p1",
      workspaceId: "w1",
    });
    const restored = await new SlackThreadSessionRegistry(
      join(tested.root, "sessions.json"),
    ).get("C1", "1.000");
    expect(restored).toMatchObject({
      status: "running",
      sessionId: "session-1",
      paneId: "w1:p1",
      binding: { cwd: tested.root },
    });
  });

  test("fails closed to a neutral session for an invalid project", async () => {
    const tested = await harness();
    const activated = await tested.registry.activate({
      channelId: "C1",
      channelName: "lc-demo",
      threadTs: "1.000",
      binding: { cwd: "/not/a/project" },
    });
    expect(activated.status).toBe("neutral");
    expect(activated.binding).toBeUndefined();
  });

  test("reopens during quiet time and retires only after expiry", async () => {
    const tested = await harness();
    await tested.registry.activate({
      channelId: "C1",
      channelName: "lc-demo",
      threadTs: "1.000",
    });
    await tested.registry.resolve("C1", "1.000", 60_000);
    tested.setNow(new Date("2026-08-12T16:00:30.000Z"));
    const reopened = await tested.registry.noteHumanReply("C1", "1.000");
    expect(reopened?.status).toBe("neutral");
    expect(reopened?.retireAfter).toBeUndefined();

    await tested.registry.resolve("C1", "1.000", 60_000);
    tested.setNow(new Date("2026-08-12T16:02:00.000Z"));
    expect((await tested.registry.retireDue()).map((session) => session.status)).toEqual(["retired"]);
  });

  test("an event the session's status does not accept leaves the file untouched", async () => {
    const tested = await harness();
    await tested.registry.activate({ channelId: "C1", channelName: "lc-demo", threadTs: "1.000" });
    await tested.registry.resolve("C1", "1.000", 60_000);
    tested.setNow(new Date("2026-08-12T16:02:00.000Z"));
    await tested.registry.retireDue();
    const before = await readFile(join(tested.root, "sessions.json"), "utf8");

    tested.setNow(new Date("2026-08-12T16:03:00.000Z"));
    const settled = await tested.registry.settle("C1", "1.000");
    await tested.registry.resolve("C1", "1.000");
    await tested.registry.attachPlan({
      channelId: "C1",
      threadTs: "1.000",
      plannedSessionId: "planned-1",
      plannedWorkspaceLabel: "[sr] demo thread",
    });
    await tested.registry.attachRuntime({ channelId: "C1", threadTs: "1.000", sessionId: "s1" });
    expect(await tested.registry.noteHumanReply("C1", "1.000")).toBeUndefined();

    expect(settled.status).toBe("retired");
    expect(await readFile(join(tested.root, "sessions.json"), "utf8")).toBe(before);
  });

  test("concurrent calls each see the other's result", async () => {
    const tested = await harness();
    await tested.registry.activate({ channelId: "C1", channelName: "lc-demo", threadTs: "1.000" });
    await tested.registry.attachRuntime({ channelId: "C1", threadTs: "1.000", sessionId: "s1" });

    await Promise.all([
      tested.registry.resolve("C1", "1.000", 60_000),
      tested.registry.settle("C1", "1.000"),
    ]);

    // Whichever runs first, the thread ends up waiting out its quiet time.
    // Reading outside the lock let the late SETTLE write `neutral` over it.
    expect(await tested.registry.get("C1", "1.000")).toMatchObject({
      status: "resolving",
      retireAfter: "2026-08-12T16:01:00.000Z",
    });
  });

  test("a retired thread that activates again starts with no runtime and no turn", async () => {
    const tested = await harness();
    await tested.registry.activate({ channelId: "C1", channelName: "lc-demo", threadTs: "1.000" });
    await tested.registry.claimTurn({ channelId: "C1", threadTs: "1.000", sourceEventId: "m1" });
    await tested.registry.attachRuntime({ channelId: "C1", threadTs: "1.000", sessionId: "s1", paneId: "w1:p1" });
    await tested.registry.markTurnLaunched("C1", "1.000", "m1");
    await tested.registry.resolve("C1", "1.000", 60_000);
    tested.setNow(new Date("2026-08-12T16:02:00.000Z"));
    await tested.registry.retireDue();

    const reopened = await tested.registry.activate({
      channelId: "C1",
      channelName: "lc-demo",
      threadTs: "1.000",
    });
    expect(reopened).toMatchObject({ status: "neutral", createdAt: "2026-08-12T16:02:00.000Z" });
    expect(reopened.sessionId).toBeUndefined();
    expect(reopened.paneId).toBeUndefined();
    expect(reopened.retireAfter).toBeUndefined();
    expect(reopened.currentTurn).toBeUndefined();
    expect(
      (await tested.registry.claimTurn({ channelId: "C1", threadTs: "1.000", sourceEventId: "m2" })).claimed,
    ).toBe(true);
  });

  test("a turn must be claimed, launched and completed in order, one message at a time", async () => {
    const tested = await harness();
    await tested.registry.activate({ channelId: "C1", channelName: "lc-demo", threadTs: "1.000" });
    const turn = { channelId: "C1", threadTs: "1.000", sourceEventId: "m1" };

    await expect(tested.registry.markTurnLaunched("C1", "1.000", "m1")).rejects.toThrow(
      "Slack thread turn m1 cannot become launched: the thread has no turn",
    );
    expect((await tested.registry.claimTurn(turn)).claimed).toBe(true);
    expect((await tested.registry.claimTurn(turn)).claimed).toBe(false);
    await expect(
      tested.registry.claimTurn({ ...turn, sourceEventId: "m2" }),
    ).rejects.toThrow("already has turn m1 in flight");
    await expect(tested.registry.completeTurn("C1", "1.000", "m1")).rejects.toThrow(
      "cannot become completed: the thread has turn m1 claimed",
    );
    await expect(tested.registry.markTurnLaunched("C1", "1.000", "m2")).rejects.toThrow(
      "cannot become launched: the thread has turn m1 claimed",
    );

    await tested.registry.markTurnLaunched("C1", "1.000", "m1");
    await tested.registry.completeTurn("C1", "1.000", "m1");
    // A retried caller repeats the last step and succeeds.
    const repeated = await tested.registry.completeTurn("C1", "1.000", "m1");
    expect(repeated.currentTurn).toMatchObject({ sourceEventId: "m1", state: "completed" });

    expect((await tested.registry.claimTurn(turn)).claimed).toBe(false);
    const next = await tested.registry.claimTurn({ ...turn, sourceEventId: "m2" });
    expect(next).toMatchObject({ claimed: true, session: { currentTurn: { sourceEventId: "m2", state: "claimed" } } });
  });

  test("rejects a stored status the machine does not have", async () => {
    const tested = await harness();
    await tested.registry.activate({ channelId: "C1", channelName: "lc-demo", threadTs: "1.000" });
    const path = join(tested.root, "sessions.json");
    const file = JSON.parse(await readFile(path, "utf8"));
    file.sessions["slack:C1:1.000"].currentTurn = { sourceEventId: "m1", state: "delivered", updatedAt: "" };
    await writeFile(path, JSON.stringify(file));

    await expect(tested.registry.get("C1", "1.000")).rejects.toThrow(
      "Unsupported Slack thread session state for slack:C1:1.000",
    );
  });

  test("turn and lifecycle calls need an existing session", async () => {
    const tested = await harness();
    await expect(
      tested.registry.claimTurn({ channelId: "C1", threadTs: "1.000", sourceEventId: "m1" }),
    ).rejects.toThrow("No Slack thread session for C1:1.000");
    await expect(tested.registry.settle("C1", "1.000")).rejects.toThrow("No Slack thread session for C1:1.000");
    expect(await tested.registry.noteHumanReply("C1", "1.000")).toBeUndefined();
    await expect(readFile(join(tested.root, "sessions.json"), "utf8")).rejects.toThrow();
  });
});
