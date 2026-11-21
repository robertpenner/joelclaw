# Lucy migration log

This log records the migration of gateway XState machines to Lucy statecharts.
It keeps two lists: what the migration changed or uncovered in each machine,
and what Lucy's language and tooling should improve.

Lucy lives in a private repository. Each machine is generated twice from its
`.lucy` source, and both outputs are checked in:

- `.xstate.machine.ts` is an XState v6 FSM built with `createFSM` from
  `xstate-v6/fsm`. The gateway installs XState 6 under that npm alias
  (`xstate-v6: npm:xstate@6.0.0-beta.3`) beside its XState 5 dependency.
- `.native.machine.ts` is a dependency-free module with the same
  `getInitialSnapshot()` and `transition(snapshot, event)` interface. The host
  runs this one.

Both import only their `.context.ts` module, so the gateway runs and
type-checks without Lucy. The machine tests run every case against both
modules. Formatting the `.lucy` source, regenerating, or rechecking laws needs
a penner checkout:

```sh
cd packages/gateway
LUCY_HOME=/path/to/penner bun run lucy:gen    # format .lucy, rewrite both .machine.ts files and .laws.txt
LUCY_HOME=/path/to/penner bun run lucy:check  # fail if unformatted, stale, or a law is unproven
```

`LUCY_HOME` defaults to a `penner` checkout beside the joelclaw checkout. No
hosted CI job runs `lucy:check`.

## gatewayAlertInvestigator

The machine moved from an inline `createMachine` in
`gateway-alert-investigator.ts` to these files in `src/`:

| File                                           | Role                                                       |
| ---------------------------------------------- | ---------------------------------------------------------- |
| `gateway-alert-investigator.lucy`              | States, events, assignments and laws                       |
| `gateway-alert-investigator.context.ts`        | Incident record, event payloads, the guard and the patches |
| `gateway-alert-investigator.xstate.machine.ts` | Generated XState v6 FSM; do not edit                       |
| `gateway-alert-investigator.native.machine.ts` | Generated with `--target ts-native`; do not edit           |
| `gateway-alert-investigator.laws.txt`          | Generated law report                                       |
| `gateway-alert-investigator.ts`                | Host: Herdr commands, file lock, persistence, telemetry    |

The XState machine held only the phase. The host patched every other field of
the incident at each call site, and chose the patch by checking the phase
first. The Lucy machine owns the whole incident as context: each handler names
the patch it applies, and the host sends an event and persists whatever
snapshot comes back.

### What the migration changed or uncovered

**Patches were chosen outside the machine.** `transitionIncident(incident,
event, patch)` applied a patch the caller supplied. The same event got
different patches depending on which branch of `alert()` sent it: `ALERT` from
`idle` opened a new incident, from `investigating` refreshed `kind` and
`ageSeconds`, and from `recovering` started a new attempt. Those three patches
are now `openIncident`, `refreshAlert` and `restartAttempt`, attached to the
handlers in the states that use them.

**A patch could land on an event the machine ignored.** `transitionIncident`
merged the patch into the incident whether or not XState took a transition. If
the host sent an event the current phase did not handle, the incident would be
rewritten under an unchanged phase. No current call path does this, but nothing
prevented it. In the generated machine an unhandled event returns the same
snapshot object, and assignments run only on a transition that is taken.
`send()` in the host writes the incident only when the snapshot changed.

**Two updates bypassed the machine entirely.** `alert()` in the four starting
phases (`ensuringHerdr` through `promptingAgent`) spread new `kind`,
`ageSeconds` and `updatedAt` into the incident without sending any event.
`recover()` did the same with the workspace Herdr returned. Both are now
handlers: `ALERT` targets its own state with `refreshAlert`, and `recovering`
handles `WORKSPACE_READY` with `recordWorkspace`, the same patch
`openingWorkspace` uses.

**`blocked` had a handler that was never sent.** The XState machine declared
`blocked: ALERT -> blocked`, but the host never sent it. It checked the back-off
window itself and either returned early or sent `RETRY`. Lucy represents that
decision as a guard on `ALERT`:

```
ALERT {
  if :retryDue -> ensuringHerdr { assign :restartAttempt }
  else -> blocked
}
```

`RETRY` is gone, and `retryDue` reproduces the host's old comparison exactly,
including treating a missing `retryAfter` as due.

**`RETRY_RECOVERY` did the same thing as `BEGIN_RECOVERY`.** Both went to
`recovering` with the same patch. The host picked one by checking whether the
phase was `recoveryBlocked`. `recoveryBlocked` now handles `BEGIN_RECOVERY`,
and the host's branch is gone. `recover()` also stopped checking for `idle` and
`recovered` itself: it sends `BEGIN_RECOVERY` and reports `idle` when the phase
did not become `recovering`.

**Opening an incident must clear `ageSeconds` explicitly.** The old host built
a fresh incident object for a new alert, so an omitted `ageSeconds` left the
field absent. A Lucy patch merges into the previous context, so `openIncident`
sets `ageSeconds: event.ageSeconds` even when that is `undefined`. Without it,
an alert with no age after a recovered incident would inherit the previous
incident's age. A machine test covers this.

**An unknown stored phase now fails with a clear error.** `readIncident`
accepted any string as a phase. XState's `resolveState` threw on an unknown
state. The generated `transition` has no default case and returns `undefined`,
which made the host crash with
`undefined is not an object (evaluating '[next]')`. `readIncident` now checks
the phase against a `Record<GatewayAlertPhase, true>`, which the compiler keeps
in sync with the machine's states, and throws `Unsupported gateway alert state`.
A host test covers this.

**Behavior change: a repeated alert is persisted before the host acts on it.**
In a starting step, the old host merged the refreshed `kind`, `ageSeconds` and
`updatedAt` in memory and wrote them with the next transition. In
`investigating`, it held them in memory through the workspace and agent probes
and wrote them once at the end. The new host writes them as soon as `ALERT` is
handled, before the step's side effect or the probes run. The final stored
incident is the same unless the process dies in between, in which case the
refreshed fields now survive. A host test reads the stored incident during the
model probe to check this.

**Open question: recovery skips the back-off window.** The first version of the
retry law,
`every path(blocked --> ensuringHerdr via ^ALERT) includes ^ALERT[:retryDue]`,
was refuted. From `blocked`, `BEGIN_RECOVERY` clears `retryAfter`, and an
`ALERT` in `recovering` or `recoveryBlocked` then restarts at once, even inside
the original back-off window. The old host behaves the same way. The law now
covers only the direct case, `no path(blocked -> ^ALERT[:retryDue] -> blocked)`.
Whether an alert after a recovery attempt should honor the earlier back-off
needs a decision from the gateway owner. `recovered` is outside the question:
an alert there opens a new incident, and `openIncident` never consults
`retryDue`.

If the answer is yes, the machine change alone is not enough.
`beginRecovery` would keep `retryAfter`, and `ALERT` in `recovering` and
`recoveryBlocked` would take the `retryDue` guard. The host decides what to do
after `ALERT` by phase: it returns early only for `blocked`, handles
`investigating`, and passes everything else to `advance()`. An `else` branch
that stays in `recovering` or `recoveryBlocked` would reach `advance()`, which
throws `Cannot advance`. The host would then send `FAILED`, which those states
ignore, and emit failure telemetry for an alert that was correctly deferred.
Either the `else` branch targets `blocked`, or `alert()` returns early for the
two recovery phases.

### Laws and mutation testing

The machine has ten laws, all proven:

| Law                                 | Statement                                                   |
| ----------------------------------- | ----------------------------------------------------------- |
| `every_state_is_reachable`          | `can reach every state`                                     |
| `every_state_can_restart`           | `every state can reach ensuringHerdr`                       |
| `failures_block`                    | `^FAILED only to blocked`                                   |
| `investigation_follows_prompt`      | `^PROMPT_ACCEPTED precedes investigating`                   |
| `recovery_needs_receipt`            | `^RECOVERY_DELIVERED precedes recovered`                    |
| `blocked_retries_when_due`          | `no path(blocked -> ^ALERT[:retryDue] -> blocked)`          |
| `due_retry_restarts_herdr`          | `some path(blocked -> ^ALERT[:retryDue] -> ensuringHerdr)`  |
| `blocked_alert_can_wait`            | `^ALERT loops on blocked`                                   |
| `alert_restarts_blocked_recovery`   | `some path(recoveryBlocked -> ^ALERT -> ensuringHerdr)`     |
| `recovery_interrupts_investigation` | `some path(investigating -> ^BEGIN_RECOVERY -> recovering)` |

Each mutation below was applied to a copy of the `.lucy` file to check that some
law fails when the machine is wrong:

| Mutation                                 | Refuted by                                                 |
| ---------------------------------------- | ---------------------------------------------------------- |
| A due retry stays in `blocked`           | `blocked_retries_when_due`                                 |
| A due retry goes to `openingWorkspace`   | `due_retry_restarts_herdr`                                 |
| A due retry goes to `recovering`         | `due_retry_restarts_herdr`                                 |
| `FAILED` goes to `ensuringHerdr`         | `failures_block`                                           |
| `AGENT_READY` skips `promptingAgent`     | `every_state_is_reachable`, `investigation_follows_prompt` |
| `RECOVERY_FAILED` goes to `recovered`    | `every_state_is_reachable`, `recovery_needs_receipt`       |
| `recovered` ignores `ALERT`              | `every_state_can_restart`                                  |
| `blocked` drops its `else` branch        | `blocked_alert_can_wait`                                   |
| `recoveryBlocked` handles nothing        | `every_state_can_restart`                                  |
| `recoveryBlocked` ignores `ALERT`        | `alert_restarts_blocked_recovery`                          |
| `investigating` ignores `BEGIN_RECOVERY` | `recovery_interrupts_investigation`                        |

Four of these mutations passed every law until a `some path` law was added for
them. `blocked_retries_when_due` only forbids a due retry from staying in
`blocked`, so sending it to `openingWorkspace` or `recovering` passed.
`recoveryBlocked` and `investigating` could still reach their targets through
other events, so removing their `ALERT` or `BEGIN_RECOVERY` handler passed too.

## slackThreadSession

The registry in `slack-thread-session.ts` tracked two things for each Slack
thread: the session's status, through an inline XState machine, and the turn
being answered, through `currentTurn.state`, which no machine described. They
are now two Lucy machines, and the registry stores both snapshots in the
existing `{ version: 1, sessions }` file:

| File                              | Role                                                    |
| --------------------------------- | ------------------------------------------------------- |
| `slack-thread-session.lucy`       | Session states, events, assignments and laws            |
| `slack-thread-session.context.ts` | Session record, event payloads, guards and patches      |
| `slack-thread-turn.lucy`          | Turn states, events, assignments and laws               |
| `slack-thread-turn.context.ts`    | Turn record, event payload, the guard and the patch     |
| `*.xstate.machine.ts`             | Generated XState v6 FSMs; do not edit                   |
| `*.native.machine.ts`             | Generated with `--target ts-native`; do not edit        |
| `*.laws.txt`                      | Generated law reports                                   |
| `slack-thread-session.ts`         | Host: binding check, file lock, stored form, public API |

The stored form is unchanged. `status` is the session machine's state;
`untracked` is never stored, because a thread without a record is untracked.
`currentTurn` holds the turn machine's state and context; `idle` is stored as
no `currentTurn`. The registry's methods and their signatures are unchanged
except that `currentTurn.state` no longer includes `"delivered"`, which nothing
ever wrote. The unused `slackThreadSessionMachine` export is gone.

Every method now reads the thread, sends one event to one machine, and writes
the result inside the file lock. Nothing is written when the machine ignores
the event.

### What the migration changed or uncovered

**Methods wrote their patch even when the machine ignored the event.** Each
method computed the next status with XState and merged its own field patch
regardless of whether XState took a transition. `resolve` on a retired thread
set `retireAfter`, `attachRuntime` on a retired thread recorded a pane, and
`settle` outside `running` changed `updatedAt`. The patches now belong to the
handlers, so an ignored event changes nothing and the host skips the write.

**Concurrent calls could store an impossible thread.** Each method read the
thread before taking the file lock and computed its status from that read.
When `resolve` and `settle` ran together on a running thread, `settle` computed
`neutral` from its stale read and wrote it over `resolve`'s result. The thread
ended `neutral` with a `retireAfter`, and `retireDue` skips threads that are
not `resolving`, so it would never retire. The new test
`concurrent calls each see the other's result` reproduces this against the old
registry.

**Reactivating a retired thread kept the old session's runtime and turn.**
`activate` built a fresh session for a retired thread, but `update()` merged it
over the stored record. The "new" session kept the old `sessionId`, `paneId`,
`workspaceId`, planned session, `retireAfter` and `currentTurn`. The plugin
reuses `sessionId` and `paneId` when they are present, and a turn left in
`launched` made every later `claimTurn` throw. In the machine, `ACTIVATE` in
`retired` applies `openSession`, which clears every optional field, and the
host resets the turn to `idle`.

**Turn steps were not ordered.** `markTurnLaunched` and `completeTurn` checked
only that the `sourceEventId` matched, so a turn could be completed before it
was launched, or launched again after it completed. The turn machine accepts
`LAUNCHED` only in `claimed` and `COMPLETED` only in `launched`. Repeating the
step a turn has already taken still succeeds, because the plugin's `read` tool
can be retried for the same message.

**Two bindings shaped one state.** `neutral` never has a binding and `bound`
always does, and a binding is never removed. The old host chose between
`SETTLE_BOUND` and `SETTLE_NEUTRAL` (and the two `HUMAN_REPLY_*` events) by
checking `binding` itself. The machine has one `SETTLE` and one `HUMAN_REPLY`,
and the `hasBinding` guard chooses the target.

**`retireDue` sends `RETIRE` to every session.** The quiet-time check moved
into the `quietOver` guard, and `retireDue` returns the sessions that the
machine moved to `retired`.

**Behavior changes for callers:**

- `settle`, `resolve`, `attachPlan` and `attachRuntime` no longer write when
  the session's status does not accept their event. They return the stored
  session unchanged.
- `markTurnLaunched` and `completeTurn` throw for a step out of order, naming
  the turn's current state.
- Turn calls update the turn's `updatedAt` and no longer the session's.
- `get` and the other readers throw `Unsupported Slack thread session state`
  for a stored status or turn state the machines do not have.

### Open questions for the owner

- **A stuck turn blocks its thread.** A turn left in `claimed` or `launched`,
  for example after a crash, makes `claimTurn` throw for every new message in
  that thread. Neither the old registry nor the new one has a way to abandon a
  turn. An `ABANDON` event or a timeout would need a decision about what to do
  with the agent that may still be running.
- **A resolving thread can start a turn.** The plugin's `runTurn` calls
  `activate` but not `noteHumanReply`, and `ACTIVATE` keeps a resolving thread
  in `resolving`. `START` there records the runtime without leaving
  `resolving`, as before, so `retireDue` can retire the thread while that turn
  runs. The daemon calls `noteHumanReply` for follow-ups, which avoids this on
  its path.

### Laws and mutation testing

The session machine has nine laws and the turn machine six, all proven:

| Law                           | Statement                                                |
| ----------------------------- | -------------------------------------------------------- |
| **slackThreadSession**        |                                                          |
| `every_state_is_reachable`    | `can reach every state`                                  |
| `every_thread_can_run_again`  | `every state can reach running`                          |
| `retirement_needs_resolve`    | `^RESOLVE precedes retired`                              |
| `only_resolving_retires`      | `^RETIRE only from resolving`                            |
| `quiet_time_over_retires`     | `some path(resolving -> ^RETIRE[:quietOver] -> retired)` |
| `early_retire_waits`          | `^RETIRE loops on resolving`                             |
| `reply_reopens`               | `no path(resolving -> ^HUMAN_REPLY -> resolving)`        |
| `settle_ends_turn`            | `no path(running -> ^SETTLE -> running)`                 |
| `untracked_only_at_start`     | `no path(to untracked)`                                  |
| **slackThreadTurn**           |                                                          |
| `every_state_is_reachable`    | `can reach every state`                                  |
| `every_turn_can_complete`     | `every state can reach completed`                        |
| `launch_follows_claim`        | `every path(idle --> launched) includes claimed`         |
| `completion_follows_launch`   | `every path(idle --> completed) includes launched`       |
| `one_turn_in_flight`          | `every path(claimed --> claimed) includes completed`     |
| `completed_turn_accepts_next` | `some path(completed -> ^CLAIM -> claimed)`              |

Each mutation below was applied to a copy of a `.lucy` file:

| Mutation                                        | Refuted by                                            |
| ----------------------------------------------- | ----------------------------------------------------- |
| A due `RETIRE` stays in `resolving`             | `every_state_is_reachable`, `quiet_time_over_retires` |
| An early `RETIRE` goes to `retired`             | `early_retire_waits`                                  |
| `SETTLE` stays in `running`                     | `settle_ends_turn`                                    |
| `HUMAN_REPLY` stays in `resolving`              | `reply_reopens`                                       |
| `retired` ignores `ACTIVATE`                    | `every_thread_can_run_again`                          |
| `retired` goes to `untracked` on `ACTIVATE`     | `untracked_only_at_start`                             |
| `bound` accepts `RETIRE`                        | `retirement_needs_resolve`, `only_resolving_retires`  |
| `running` accepts `RETIRE`                      | `retirement_needs_resolve`, `only_resolving_retires`  |
| `claimed` accepts `CLAIM`                       | `one_turn_in_flight`                                  |
| `launched` accepts `CLAIM`                      | `one_turn_in_flight`                                  |
| `claimed` accepts `COMPLETED`                   | `completion_follows_launch`                           |
| `completed` ignores `CLAIM`                     | `completed_turn_accepts_next`                         |
| `CLAIM` from `idle` goes straight to `launched` | `launch_follows_claim`                                |

The ordering of turn steps and the one-turn-at-a-time rule were checks
scattered through three methods. They are now the laws `launch_follows_claim`,
`completion_follows_launch` and `one_turn_in_flight`.

## Suggested improvements to Lucy

### Language

- **Negated guard qualifiers.** A qualifier accepts one guard name
  (`[:retryDue]`). `[not :retryDue]` does not parse, so a law cannot select the
  `else` branch of a guarded handler.
- **Conditions on longer path patterns.** `every path(A -> B) includes ^E[:g]`
  is reported `unsupported`; only `A --> B` patterns take conditions today.
- **Formula destinations that overlap the source.**
  `path(blocked -> ^ALERT[:g] -> (not ensuringHerdr))` is rejected because the
  destination formula includes the source. A single named destination works.
- **Context laws over non-numeric fields.** Context laws support only numeric
  fields, so no law can state that every restart clears `retryAfter` or that
  only `openIncident` changes `incidentId`. This record is mostly ISO strings
  and ids.
- **Reusable handlers.** The four starting states repeat the same `ALERT`,
  `FAILED` and `BEGIN_RECOVERY` handlers. A compound parent would hold them
  once, but `ts-native` accepts only flat machines. A named handler that several
  states could reference would remove the repetition in flat machines. Handler
  constants today are values local to one handler. `slackThreadSession` repeats
  its `ACTIVATE`, `PLAN` and `HUMAN_REPLY` handlers in up to four states for
  the same reason.
- **Computed `after` delays.** (From the survey of the other gateway machines.)
  `signalLifecycle` computes its snooze delay from context, and `after` accepts
  only literal durations.

### `ts-native` target

- **Compound states.** The target rejects hierarchy, which forces the
  repetition above.
- **Targetless handlers.** The target rejects them, so handlers that only update
  context need a self-target (`ALERT -> ensuringHerdr`).
- **Exported types and state names.** The module exports only the machine.
  Hosts derive `Snapshot` and `Event` with
  `ReturnType<typeof m.getInitialSnapshot>` and
  `Parameters<typeof m.transition>[1]`, and keep their own list of state names
  to validate persisted snapshots.
- **Restoring a persisted snapshot.** There is no `resolveState` equivalent. The
  host builds
  `{ status: "active", value, context, output: undefined, error: undefined }` by
  hand.
- **Unknown states.** `transition` has no default case, so a snapshot with an
  unknown `value` returns `undefined` instead of failing with a message that
  names the state.
- **Accepted versus ignored events.** An ignored event and an accepted one
  that changes nothing (an `else` branch with no assignment, such as an early
  `RETIRE`) both return the same snapshot object. The session host does not
  need the difference, but `markTurnLaunched` has to tell "already launched"
  from "out of order" by inspecting the state itself. A `can(snapshot, event)`
  function, or a flag in the result, would answer that directly.

### Law checker and tooling

- **Exit code for unsupported laws.** `--laws` exits 1 when a law is refuted but
  0 when a law is `unsupported`, so a script must read verdicts to know every
  law was checked.
- **One verdict format in the text report.** A proven law prints
  `law NAME: proven`; a refuted law prints a `Refuted: law NAME` block. The
  `lucy:check` script reads `--laws --json`, whose `status` field covers both.
- **Mutation testing.** The mutations above were applied by hand. A mode that
  retargets transitions, drops handlers and drops guard branches, then reports
  which mutants no law refutes, would have found the two missing `some path`
  laws automatically.
- **A formatter on the compiler CLI.** The formatter is
  `vscode/formattingCli.ts`, a script inside the VS Code extension's directory,
  while compiling and law checking go through `statechart/main.ts`. A
  `main.ts --format [--check]` would put every command a project needs behind
  one entry point.
- **The XState v6 import specifier is fixed.** The default target always
  imports `xstate-v6/fsm`, which is penner's npm alias. Another project must
  install XState 6 under exactly that name. An option to emit `xstate/fsm`, for
  a project whose only XState is version 6, would remove the alias.
- **A distributable compiler.** Lucy is unpublished and its repository is
  private, so a public repository cannot run `lucy:check` in CI. A published
  CLI package would let hosted CI catch a stale generated module.
