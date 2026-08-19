// Divergence catalog: weird states the legacy data layer (createData) can get
// into that the sync engine cannot. Each test drives the REAL legacy layer and
// PASSES by demonstrating the bug, with a pointer to the engine law or
// mechanism that rules the same state out. If a test here starts failing, the
// legacy layer got fixed — celebrate and delete the test.
//
// Companion clean-behavior proofs: test/sync-engine-laws.test.ts.

import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createData } from "../src/solid/data"
import type { CreateDataInput } from "../src/solid/data"
import type { OpenCodeEvent, SessionMessageInfo } from "../src/promise"

const sessionID = "ses_legacy"
const assistantID = "msg_assistant"

describe("legacy data layer divergence catalog", () => {
  test("a dropped durable event desyncs the transcript silently and forever", async () => {
    // Server truth: the assistant message finished with text "FINAL".
    // The client misses only the `session.text.ended` event (blip mid-stream).
    const legacy = await hydrated()
    legacy.dispatch(textStarted())
    for (let index = 0; index < 5; index++) legacy.dispatch(textDelta("x"))
    // ...the `ended` event with the durable final text never arrives.

    // The transcript is stuck on accumulated deltas, disagreeing with the
    // server, and nothing in the layer can ever notice: there is no sequence
    // cursor, no gap check, no recovery path. Only a manual refetch heals it.
    expect(legacy.text()).toBe("xxxxx")
    legacy.dispose()
    // Engine: durable events carry seqs; a gap surfaces as SeqUnavailable or a
    // marker past the fold, forcing snapshot recovery (laws 7 and 8).
  })

  test("a late delta corrupts a completed message", async () => {
    // Events delivered slightly out of order: the final text lands, then a
    // straggling delta from the finished stream arrives.
    const legacy = await hydrated()
    legacy.dispatch(textStarted())
    legacy.dispatch(textDelta("Hel"))
    legacy.dispatch(textEnded("Hello"))
    legacy.dispatch(textDelta("lo"))

    // The handler appends onto whatever text part it finds — including a
    // completed one. The final message is permanently corrupted.
    expect(legacy.text()).toBe("Hellolo")
    legacy.dispose()
    // Engine: deltas live in an ephemeral overlay cleared by the durable
    // lifecycle, and the fold applies durable events in seq order, so a stale
    // delta can never touch a completed message (law 3, overlay semantics).
  })

  test("a slow fetch rewinds the store past already-rendered live events", async () => {
    // The initial message fetch is in flight when a live prompt admission
    // arrives. The user's message renders... then the stale fetch resolves.
    let resolveFetch: ((messages: SessionMessageInfo[]) => void) | undefined
    const legacy = makeLegacy({
      list: () => new Promise<SessionMessageInfo[]>((resolve) => (resolveFetch = resolve)),
    })
    const syncing = legacy.data.session.message.sync(sessionID)
    legacy.dispatch(inboxEnqueued("msg_user"))
    expect(legacy.data.session.message.get(sessionID, "msg_user")).toBeDefined()

    resolveFetch!([]) // the fetch was served before the admission — stale
    await syncing

    // The message the user just watched appear is gone. It returns only if
    // some later event or refetch happens to bring it back.
    expect(legacy.data.session.message.get(sessionID, "msg_user")).toBeUndefined()
    legacy.dispose()
    // Engine: hydration is a seq-stamped snapshot, and "snapshot refresh
    // cannot move the fold behind the live log" is a tested law.
  })

  test("delivered-before-enqueued leaves a phantom pending row forever", async () => {
    // Reordered delivery: the `delivered` event arrives before its `enqueued`.
    const legacy = await hydrated()
    legacy.dispatch(inboxDelivered("msg_user")) // no-op: nothing to deliver yet
    legacy.dispatch(inboxEnqueued("msg_user")) // adds the pending row

    // The delivered event was already consumed, so the row the server has
    // long since promoted sits in "pending" until a manual refetch.
    expect(legacy.data.session.pending.list(sessionID).map((item) => item.id)).toEqual(["msg_user"])
    legacy.dispose()
    // Engine: the durable log is consumed in seq order, so this ordering
    // cannot be observed; any transport reordering fails the cursor check and
    // recovers via snapshot (laws 7 and 8).
  })
})

// Not runnable client-side, but part of the catalog:
// - Duplicate admission on retry: the legacy prompt protocol has no
//   client-minted dedupe ID, so a retry after a lost response admits twice.
//   The engine's exactly-once admission is law 1, and the durable echo ack is
//   what settles the outbox. (This bug family was observed live during
//   development as the minted-ID regression.)
// - The layer documents its own event-vs-fetch race: see the session.created
//   "band-aid" comment in src/solid/data.ts (skipping racy initial reads).

function makeLegacy(overrides: { list?: () => Promise<SessionMessageInfo[]> } = {}) {
  let handler: ((event: { name: OpenCodeEvent["type"]; details: OpenCodeEvent }) => void) | undefined
  const api = {
    session: {
      get: async () => ({
        id: sessionID,
        projectID: "project",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 2 },
        location: { directory: "/workspace" },
      }),
    },
    message: {
      list: async () => ({
        data: overrides.list ? await overrides.list() : transcript().toReversed(),
        cursor: {},
      }),
    },
  } as unknown as ReturnType<CreateDataInput["api"]>
  return createRoot((dispose) => {
    const data = createData({
      api: () => api,
      directory: "/workspace",
      event: {
        on: () => () => {},
        listen(next) {
          handler = next
          return () => {}
        },
      },
    })
    return {
      data,
      dispose,
      dispatch(event: { type: OpenCodeEvent["type"] } & Record<string, unknown>) {
        handler?.({ name: event.type, details: event as unknown as OpenCodeEvent })
      },
      text() {
        const message = data.session.message.get(sessionID, assistantID)
        const part =
          message?.type === "assistant" ? message.content.findLast((item) => item.type === "text") : undefined
        return part?.type === "text" ? part.text : undefined
      },
    }
  })
}

async function hydrated() {
  const legacy = makeLegacy()
  await legacy.data.session.sync(sessionID)
  await legacy.data.session.message.sync(sessionID)
  return legacy
}

function transcript(): SessionMessageInfo[] {
  return [
    { id: "msg_earlier", type: "user", text: "earlier", time: { created: 1 } },
    { id: assistantID, type: "assistant", time: { created: 2 }, agent: "build", content: [] } as SessionMessageInfo,
  ]
}

const textStarted = () => ({
  id: "evt_start",
  created: 3,
  type: "session.text.started" as const,
  data: { sessionID, assistantMessageID: assistantID, ordinal: 0 },
})

const textDelta = (delta: string) => ({
  id: "evt_delta",
  created: 4,
  type: "session.text.delta" as const,
  data: { sessionID, assistantMessageID: assistantID, ordinal: 0, delta },
})

const textEnded = (text: string) => ({
  id: "evt_end",
  created: 5,
  type: "session.text.ended" as const,
  data: { sessionID, assistantMessageID: assistantID, ordinal: 0, text },
})

const inboxEnqueued = (inboxID: string) => ({
  id: "evt_enqueued",
  created: 6,
  type: "session.inbox.enqueued" as const,
  data: {
    sessionID,
    inboxID,
    item: { type: "user", delivery: "steer", payload: { text: "hello" } },
  },
})

const inboxDelivered = (inboxID: string) => ({
  id: "evt_delivered",
  created: 7,
  type: "session.inbox.delivered" as const,
  data: { sessionID, inboxID },
})
