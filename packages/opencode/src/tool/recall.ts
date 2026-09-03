import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./recall.txt"
import { Recall } from "@opencode-ai/core/recall/indexer"

// Sprint 5 fix (anti-loop): per-session call counter. Recall can be invoked
// repeatedly by the LLM when context is auto-injected (M3), producing doom_loop
// warnings and 60s+ timeouts. We refuse calls > MAX_CALLS_PER_SESSION per
// session — context is already in system, no need to re-inject.
const callCounts = new Map<string, number>()
const MAX_CALLS_PER_SESSION = 2

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({
    description: "Natural language query against past conversation transcripts (all local sessions)",
  }),
  limit: Schema.optional(
    Schema.Int.annotate({ description: "Maximum number of hits to return (default 5)" }),
  ),
})

export const RecallTool = Tool.define(
  "recall",
  Effect.gen(function* () {
    const recall = yield* Recall.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (args: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          // Sprint 5: anti-loop. Per-session cap. M3 may auto-inject context
          // before the LLM's first turn, so the LLM doesn't need to call recall
          // itself; if it does anyway, refuse after MAX_CALLS_PER_SESSION.
          const sid = ctx.sessionID
          const calls = (callCounts.get(sid) ?? 0) + 1
          if (calls > MAX_CALLS_PER_SESSION) {
            return {
              title: `recall ${args.query} (limit reached)`,
              metadata: { count: 0, sessions: [], limitReached: true, calls },
              output:
                `Recall already invoked ${MAX_CALLS_PER_SESSION} times in this session ` +
                `(auto-inject via OPENCODE_RECALL_AUTO_INVOKE may have populated context already). ` +
                `Use the existing system context to answer; do not re-query.`,
            }
          }
          callCounts.set(sid, calls)
          const hits = yield* recall.search({ query: args.query, limit: args.limit ?? 5 })
          const sessions = [...new Set(hits.map((hit) => hit.sessionID))]
          if (hits.length === 0) {
            return {
              title: `recall ${args.query}`,
              metadata: { count: 0, sessions },
              output: `No transcript matches for "${args.query}".`,
            }
          }
          const output = hits
            .map((hit, index) => {
              const snippet = hit.text.length > 600 ? `${hit.text.slice(0, 600)}…` : hit.text
              return `[${index + 1}] session=${hit.sessionID} score=${hit.score.toFixed(3)}\n${snippet}`
            })
            .join("\n\n---\n\n")
          return {
            title: `recall ${args.query}`,
            metadata: { count: hits.length, sessions, calls },
            output,
          }
        }),
    }
  }),
)
