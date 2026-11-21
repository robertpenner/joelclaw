import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import type { SlackThreadRecord } from "./slack-thread-session.context";
import { slackThreadSession } from "./slack-thread-session.native.machine";
import { slackThreadTurn } from "./slack-thread-turn.native.machine";
import type { SlackChannelContextBinding } from "./slack-work-request";

export const DEFAULT_SLACK_THREAD_SESSIONS_PATH = resolve(
  homedir(),
  ".joelclaw/slack-thread-sessions.json",
);
export const DEFAULT_SLACK_THREAD_QUIET_TIMEOUT_MS = 30 * 60_000;

type SessionSnapshot = ReturnType<typeof slackThreadSession.getInitialSnapshot>;
type SessionEvent = Parameters<typeof slackThreadSession.transition>[1];
type TurnSnapshot = ReturnType<typeof slackThreadTurn.getInitialSnapshot>;
type TurnEvent = Parameters<typeof slackThreadTurn.transition>[1];

/** A stored session is never `untracked`; that state means no record exists. */
export type SlackThreadSessionStatus = Exclude<SessionSnapshot["value"], "untracked">;
/** A stored turn is never `idle`; that state means `currentTurn` is absent. */
export type SlackThreadTurnState = Exclude<TurnSnapshot["value"], "idle">;

/** The stored form of a thread's session and turn snapshots. */
export type SlackThreadSession = SlackThreadRecord & {
  readonly status: SlackThreadSessionStatus;
  readonly currentTurn?: {
    readonly sourceEventId: string;
    readonly state: SlackThreadTurnState;
    readonly updatedAt: string;
  };
};

type SlackThreadSessionFile = {
  readonly version: 1;
  readonly sessions: Readonly<Record<string, SlackThreadSession>>;
};

/** A thread's two machine snapshots. A thread with no record is untracked and idle. */
type Thread = { readonly session: SessionSnapshot; readonly turn: TurnSnapshot };

// `ts-native` exports no list of state names, and its `transition` returns
// undefined for an unknown one, so stored states are checked against these.
const statuses: Record<SlackThreadSessionStatus, true> = {
  neutral: true,
  bound: true,
  running: true,
  resolving: true,
  retired: true,
};
const turnStates: Record<SlackThreadTurnState, true> = {
  claimed: true,
  launched: true,
  completed: true,
};

function threadOf(stored: SlackThreadSession | undefined): Thread {
  if (!stored) {
    return {
      session: slackThreadSession.getInitialSnapshot(),
      turn: slackThreadTurn.getInitialSnapshot(),
    };
  }
  const { status, currentTurn, ...record } = stored;
  return {
    session: { status: "active", value: status, context: record, output: undefined, error: undefined },
    turn: currentTurn
      ? {
          status: "active",
          value: currentTurn.state,
          context: { sourceEventId: currentTurn.sourceEventId, updatedAt: currentTurn.updatedAt },
          output: undefined,
          error: undefined,
        }
      : slackThreadTurn.getInitialSnapshot(),
  };
}

/** Returns the stored form of a thread, or undefined while it is untracked. */
function storedOf({ session, turn }: Thread): SlackThreadSession | undefined {
  const status = session.value;
  if (status === "untracked") return undefined;
  const state = turn.value;
  return {
    ...session.context,
    status,
    ...(state === "idle" ? {} : { currentTurn: { ...turn.context, state } }),
  };
}

function sendSession(snapshot: SessionSnapshot, event: SessionEvent): SessionSnapshot {
  return slackThreadSession.transition(snapshot, event)[0];
}

function sendTurn(snapshot: TurnSnapshot, event: TurnEvent): TurnSnapshot {
  return slackThreadTurn.transition(snapshot, event)[0];
}

function threadId(channelId: string, threadTs: string): string {
  return `slack:${channelId}:${threadTs}`;
}


function bindingRoot(binding: SlackChannelContextBinding | undefined): string | undefined {
  return binding?.cwd?.trim() || binding?.repo?.trim();
}

async function verifiedBinding(
  binding: SlackChannelContextBinding | undefined,
): Promise<SlackChannelContextBinding | undefined> {
  const root = bindingRoot(binding);
  if (!root || !isAbsolute(root)) return undefined;
  try {
    if (!(await stat(root)).isDirectory()) return undefined;
    if (binding?.brainEntry) {
      await stat(resolve(root, binding.brainEntry));
    }
    return binding;
  } catch {
    return undefined;
  }
}

async function readFileState(path: string): Promise<SlackThreadSessionFile> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as SlackThreadSessionFile;
    const sessions = value?.sessions && typeof value.sessions === "object"
      ? value.sessions
      : {};
    for (const session of Object.values(sessions)) {
      if (
        !Object.hasOwn(statuses, session.status)
        || (session.currentTurn && !Object.hasOwn(turnStates, session.currentTurn.state))
      ) {
        throw new Error(`Unsupported Slack thread session state for ${session.threadId} at ${path}`);
      }
    }
    return { version: 1, sessions };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, sessions: {} };
    }
    throw error;
  }
}

async function writeFileState(
  path: string,
  sessions: Readonly<Record<string, SlackThreadSession>>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function removeStaleLock(lockPath: string): Promise<boolean> {
  try {
    const rawPid = Number.parseInt((await readFile(lockPath, "utf8")).trim(), 10);
    if (!Number.isSafeInteger(rawPid) || rawPid < 1) {
      await rm(lockPath, { force: true });
      return true;
    }
    try {
      process.kill(rawPid, 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
      await rm(lockPath, { force: true });
      return true;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    return false;
  }
}

async function withFileLock<T>(path: string, run: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  await mkdir(dirname(lockPath), { recursive: true });
  const started = Date.now();
  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`, "utf8");
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await removeStaleLock(lockPath)) continue;
      if (Date.now() - started > 10_000) {
        throw new Error(`Timed out acquiring Slack thread session lock ${lockPath}`);
      }
      await wait(25);
    }
  }
  try {
    return await run();
  } finally {
    await rm(lockPath, { force: true });
  }
}

export class SlackThreadSessionRegistry {
  constructor(
    private readonly path = process.env.SLACK_SHITRAT_THREAD_SESSIONS_PATH?.trim()
      || DEFAULT_SLACK_THREAD_SESSIONS_PATH,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async get(channelId: string, threadTs: string): Promise<SlackThreadSession | undefined> {
    return (await readFileState(this.path)).sessions[threadId(channelId, threadTs)];
  }

  async listActive(): Promise<SlackThreadSession[]> {
    const sessions = Object.values((await readFileState(this.path)).sessions);
    return sessions.filter((session) => session.status !== "retired");
  }

  /** Opens a session, or refreshes one. A retired thread starts over with no turn. */
  async activate(input: {
    readonly channelId: string;
    readonly channelName: string;
    readonly threadTs: string;
    readonly binding?: SlackChannelContextBinding;
  }): Promise<SlackThreadSession> {
    const binding = await verifiedBinding(input.binding);
    const id = threadId(input.channelId, input.threadTs);
    return this.change(id, (thread) => {
      const session = sendSession(thread.session, {
        type: "ACTIVATE",
        threadId: id,
        channelId: input.channelId,
        channelName: input.channelName,
        threadTs: input.threadTs,
        binding,
        now: this.stamp(),
      });
      const turn = thread.session.value === "retired"
        ? slackThreadTurn.getInitialSnapshot()
        : thread.turn;
      return { session, turn };
    }, (stored) => stored!);
  }

  /** Returns undefined for a thread with no live session. */
  async noteHumanReply(
    channelId: string,
    threadTs: string,
  ): Promise<SlackThreadSession | undefined> {
    return this.change(
      threadId(channelId, threadTs),
      (thread) => ({
        ...thread,
        session: sendSession(thread.session, { type: "HUMAN_REPLY", now: this.stamp() }),
      }),
      (stored) => (stored?.status === "retired" ? undefined : stored),
    );
  }

  /**
   * Claims a turn for `sourceEventId`. Claiming the current turn again returns
   * `claimed: false`; claiming another while one is in flight throws.
   */
  async claimTurn(input: {
    readonly channelId: string;
    readonly threadTs: string;
    readonly sourceEventId: string;
  }): Promise<{ readonly claimed: boolean; readonly session: SlackThreadSession }> {
    let claimed = false;
    const session = await this.changeSession(input.channelId, input.threadTs, (thread) => {
      const turn = sendTurn(thread.turn, {
        type: "CLAIM",
        sourceEventId: input.sourceEventId,
        now: this.stamp(),
      });
      claimed = turn !== thread.turn;
      if (!claimed && thread.turn.context.sourceEventId !== input.sourceEventId) {
        throw new Error(
          `Slack thread session ${threadId(input.channelId, input.threadTs)} already has turn ${thread.turn.context.sourceEventId} in flight`,
        );
      }
      return { ...thread, turn };
    });
    return { claimed, session };
  }

  /** Repeating the step the turn already took is allowed, so a retried caller succeeds. */
  async markTurnLaunched(
    channelId: string,
    threadTs: string,
    sourceEventId: string,
  ): Promise<SlackThreadSession> {
    return this.advanceTurn(channelId, threadTs, { type: "LAUNCHED", sourceEventId, now: this.stamp() }, "launched");
  }

  async completeTurn(
    channelId: string,
    threadTs: string,
    sourceEventId: string,
  ): Promise<SlackThreadSession> {
    return this.advanceTurn(channelId, threadTs, { type: "COMPLETED", sourceEventId, now: this.stamp() }, "completed");
  }

  async attachPlan(input: {
    readonly channelId: string;
    readonly threadTs: string;
    readonly plannedSessionId: string;
    readonly plannedWorkspaceLabel: string;
  }): Promise<SlackThreadSession> {
    return this.sendToSession(input.channelId, input.threadTs, {
      type: "PLAN",
      plannedSessionId: input.plannedSessionId,
      plannedWorkspaceLabel: input.plannedWorkspaceLabel,
      now: this.stamp(),
    });
  }

  async attachRuntime(input: {
    readonly channelId: string;
    readonly threadTs: string;
    readonly sessionId: string;
    readonly sessionFile?: string;
    readonly paneId?: string;
    readonly workspaceId?: string;
  }): Promise<SlackThreadSession> {
    return this.sendToSession(input.channelId, input.threadTs, {
      type: "START",
      sessionId: input.sessionId,
      sessionFile: input.sessionFile,
      paneId: input.paneId,
      workspaceId: input.workspaceId,
      now: this.stamp(),
    });
  }

  async settle(channelId: string, threadTs: string): Promise<SlackThreadSession> {
    return this.sendToSession(channelId, threadTs, { type: "SETTLE", now: this.stamp() });
  }

  async resolve(
    channelId: string,
    threadTs: string,
    quietTimeoutMs = DEFAULT_SLACK_THREAD_QUIET_TIMEOUT_MS,
  ): Promise<SlackThreadSession> {
    return this.sendToSession(channelId, threadTs, {
      type: "RESOLVE",
      quietTimeoutMs,
      now: this.stamp(),
    });
  }

  /** Sends `RETIRE` to every session and returns those that retired. */
  async retireDue(): Promise<SlackThreadSession[]> {
    return withFileLock(this.path, async () => {
      const state = await readFileState(this.path);
      const now = this.stamp();
      const sessions = { ...state.sessions };
      const changed: SlackThreadSession[] = [];
      for (const [id, stored] of Object.entries(state.sessions)) {
        const thread = threadOf(stored);
        const session = sendSession(thread.session, { type: "RETIRE", now });
        const next = storedOf({ ...thread, session });
        if (session === thread.session || !next) continue;
        sessions[id] = next;
        changed.push(next);
      }
      if (changed.length > 0) await writeFileState(this.path, sessions);
      const retired = changed.filter((session) => session.status === "retired");
      return retired;
    });
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  /**
   * Reads one thread inside the file lock, applies `step`, and writes the
   * thread back only when a machine accepted an event.
   */
  private async change<T>(
    id: string,
    step: (thread: Thread) => Thread,
    result: (stored: SlackThreadSession | undefined) => T,
  ): Promise<T> {
    return withFileLock(this.path, async () => {
      const state = await readFileState(this.path);
      const thread = threadOf(state.sessions[id]);
      const next = step(thread);
      const stored = storedOf(next);
      if (stored && (next.session !== thread.session || next.turn !== thread.turn)) {
        await writeFileState(this.path, { ...state.sessions, [id]: stored });
      }
      return result(stored);
    });
  }

  /** Like `change`, for a thread that must already have a session. */
  private async changeSession(
    channelId: string,
    threadTs: string,
    step: (thread: Thread) => Thread,
  ): Promise<SlackThreadSession> {
    return this.change(
      threadId(channelId, threadTs),
      (thread) => {
        if (thread.session.value === "untracked") {
          throw new Error(`No Slack thread session for ${channelId}:${threadTs}`);
        }
        return step(thread);
      },
      (stored) => stored!,
    );
  }

  /** A session ignores an event its state does not accept, and nothing is written. */
  private async sendToSession(
    channelId: string,
    threadTs: string,
    event: SessionEvent,
  ): Promise<SlackThreadSession> {
    return this.changeSession(channelId, threadTs, (thread) => ({
      ...thread,
      session: sendSession(thread.session, event),
    }));
  }

  private async advanceTurn(
    channelId: string,
    threadTs: string,
    event: TurnEvent,
    reached: SlackThreadTurnState,
  ): Promise<SlackThreadSession> {
    return this.changeSession(channelId, threadTs, (thread) => {
      const turn = sendTurn(thread.turn, event);
      const repeated = thread.turn.value === reached
        && thread.turn.context.sourceEventId === event.sourceEventId;
      if (turn === thread.turn && !repeated) {
        const current = thread.turn.value === "idle"
          ? "no turn"
          : `turn ${thread.turn.context.sourceEventId} ${thread.turn.value}`;
        throw new Error(
          `Slack thread turn ${event.sourceEventId} cannot become ${reached}: the thread has ${current}`,
        );
      }
      return { ...thread, turn };
    });
  }
}
