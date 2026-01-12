# Trace events

This file defines the _canonical_ JSONL trace event vocabulary.

Events represent _completed facts_ and are named in the past tense (`did*`).

The schema is stable and append-only.

---

## Common fields (present on all events)

All events are wrapped in a canonical JSONL envelope with the following fields:

- `v` — schema version (number)
- `ts` — ISO timestamp (added by the bridge)
- `seq` — monotonic sequence number (added by the bridge)
- `src.layer` — one of `bridge | ext | webview`
- `src.runId` — unique id per process start
- `src.pid` — process id
- Optional correlation fields:
  - `monitorSessionId`
  - `portKey`
  - `clientId`
  - `webviewId`
  - `webviewType`
- `data` — small, event-specific payload (must be shallow)

Fields are additive and must never be removed or renamed.

---

## Bridge lifecycle

### `bridgeDidStart`

- Emitted when the bridge is fully initialized.
- `data.identity` (version, commit, mode)
- `data.heartbeat` (intervalMs, timeoutMs)

### `bridgeDidStop`

- Emitted on shutdown.
- `data.reason` (`exit | signal | crash`)

---

## Client connectivity

### `clientDidConnect`

- Emitted when a client session is registered.
- Required fields: `clientId`
- Optional: `webviewId`, `webviewType`

### `clientDidDisconnect`

- Emitted when a client session ends.
- Required fields: `clientId`
- `data.reason` (`ws-close | timeout | error`)

---

## Attachments and heartbeat

### `attachmentDidAttach`

- Emitted when an attachment token is created.
- `data.tokenHash` (hashed, never raw)

### `heartbeatDidReceive`

- Emitted when a heartbeat updates last-seen.
- Must be throttled.
- `data.tokenHash`
- `data.ageMs`

### `attachmentDidPrune`

- Emitted when stale attachments are removed.
- `data.prunedCount`
- `data.timeoutMs`
- `data.maxAgeMs`

---

## Monitor lifecycle

### `monitorDidStart`

- Emitted when a monitor is actively running.
- Required: `monitorSessionId`, `portKey`
- `data.baudrate`
- `data.paused = false`

### `monitorDidStop`

- Emitted when the monitor fully stops.
- Required: `monitorSessionId`
- `data.reason` (`user | last-client | error | bridge-restart`)

### `monitorDidSuspend`

- Emitted when the monitor is suspended.
- Required: `monitorSessionId`
- `data.reason` (`task | command`)
- `data.released` (boolean)

### `monitorDidResume`

- Emitted when the monitor resumes after suspend.
- Required: `monitorSessionId`
- `data.portChanged` (boolean)
- `data.newPortKey` (if changed)

### `monitorDidFail`

- Emitted on unrecoverable monitor errors.
- `data.op` (`start | stop | suspend | resume`)
- `data.message`
- Optional `data.code`

### `monitorDidChangeBaudrate`

- Emitted when baudrate actually changes.
- Required: `monitorSessionId`, `portKey`
- `data.oldBaudrate`
- `data.newBaudrate`
- `data.origin` (`ui | settings | profile | auto`)

---

## Tasks (extension-forwarded)

### `taskDidStart`

- Emitted when a task begins execution.
- `data.taskId`
- `data.taskKind` (`upload | uploadUsingProgrammer | burnBootloader | custom`)
- `data.taskName`

### `taskDidFinish`

- Emitted when a task finishes successfully.
- `data.taskId`
- `data.durationMs`

### `taskDidFail`

- Emitted when a task fails.
- `data.taskId`
- `data.message`
- Optional `data.exitCode`

---

## Ports

### `portsDidUpdate`

- Emitted when the detected ports snapshot changes.
- Debounced.
- `data.count`
- Optional `data.added`, `data.removed` (counts)

---

## Codex task: write bridge trace JSONL (v1)

### Goal

- Bridge writes a canonical JSONL trace file for each bridge run.
- Extension/webviews may forward trace events to the bridge; the bridge is the single writer.

### Output files

- Directory: `os.tmpdir()/.boardlab/monitor-bridge/`
- **Current run (stable path)**: `events.jsonl`
  - Always represents the currently running bridge instance.
  - Safe to `tail -f` from the filesystem.
- **Rotated runs**: `events-<runId>.jsonl`
  - Written on bridge startup or shutdown.
  - `runId` must include a sortable timestamp (epoch seconds or ISO-like).
  - Used for post-mortem inspection.

### Implementation notes

- Create a `runId` at startup and include it in all `src.*` fields.
- Maintain a monotonic `seq` counter in the bridge (starting at 1).
- Add `ts` and `seq` in the bridge even for forwarded events.
- Writes must be append-only; failures must not crash the bridge (best-effort logging).
- Keep `data` shallow; never log raw tokens (hash to `tokenHash`). (make this super simple that can be replaced by a lib. no sophisticated filtering is needed, it's the consideration the key part)

### Log unification (optional, recommended)

- Bridge may emit `logDidWrite` trace events to represent human-readable log lines.
- This allows deprecating the separate “monitor bridge log” file and output channel.
- `logDidWrite` must be emitted only by the origin (bridge); forwarded logs must not be re-emitted to avoid feedback loops.
- Extension UI may filter trace events by `event === "logDidWrite"` to present a traditional log view.

### Emit points (minimum)

- Emit `bridgeDidStart` after server is listening.
- Emit `clientDidConnect`/`clientDidDisconnect` on session lifecycle.
- Emit `attachmentDidAttach`, throttled `heartbeatDidReceive`, and `attachmentDidPrune`.
- Emit `monitorDidStart`/`monitorDidStop`/`monitorDidSuspend`/`monitorDidResume`/`monitorDidFail`.
- Emit debounced `portsDidUpdate` from detected ports watcher.

### Forwarded events

- Accept forwarded events from extension/webviews (JSON-RPC notification suggested).
- Preserve provided correlation fields (`monitorSessionId`, `portKey`, `clientId`, `webviewId`, `webviewType`) but ensure `ts`/`seq` are bridge-assigned.
- Set `src.layer` to the origin (`ext`/`webview`) when forwarded.

### File rotation and tailing behavior

- On bridge startup:
  - If an existing `events.jsonl` is present and non-empty, rename it to `events-<previousRunId or mtime>.jsonl`.
  - Create a fresh `events.jsonl` for the new run.
- The first line of a new `events.jsonl` must be `bridgeDidStart`.
- “Tail latest” semantics:
  - Current run: tail `events.jsonl`.
  - Most recent completed run: select the rotated file with the greatest `mtime`.

### Acceptance

- Running the bridge creates/updates `events.jsonl`.
- Each JSON line parses as JSON and contains `v`, `ts`, `seq`, `src.layer`, `src.runId`, `src.pid`, `event`.
- A suspend/resume flow produces at least: `bridgeDidStart`, `clientDidConnect`, `monitorDidStart`, `monitorDidSuspend`, `monitorDidResume`, `clientDidDisconnect`.
- Tailing `events.jsonl` provides a complete, ordered view of bridge activity without relying on a separate bridge log file or channel.
