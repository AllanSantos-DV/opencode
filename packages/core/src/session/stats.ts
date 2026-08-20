export * as SessionStats from "./stats.js"

import { DateTime, Effect, Option, Schema } from "effect"
import { and, eq, gte, inArray, lt } from "drizzle-orm"
import { Money } from "@opencode-ai/schema/money"
import { Project } from "@opencode-ai/schema/project"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { Database } from "../database/database.js"
import { EventTable } from "../event/sql.js"
import { SessionMessageTable, SessionTable } from "./sql.js"

type Input = {
  readonly from?: number
  readonly to?: number
  readonly projectID?: Project.ID
  readonly timezone?: string
}

type Tokens = {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

type ModelAggregate = {
  model: SessionMessage.Assistant["model"]
  steps: number
  tokens: Tokens
  cost: number
}

type ToolAggregate = {
  name: string
  calls: number
  succeeded: number
  failed: number
  unfinished: number
  durations: number[]
}

const decodeMessage = Schema.decodeUnknownOption(SessionMessage.Info)
const decodeUsage = Schema.decodeUnknownOption(SessionEvent.UsageRecorded.data)

export const get = Effect.fn("SessionStats.get")(function* (input: Input = {}) {
  const db = (yield* Database.Service).db
  const rows = yield* db
    .select({
      id: SessionMessageTable.id,
      sessionID: SessionMessageTable.session_id,
      parentID: SessionTable.parent_id,
      type: SessionMessageTable.type,
      data: SessionMessageTable.data,
      timeCreated: SessionMessageTable.time_created,
    })
    .from(SessionMessageTable)
    .innerJoin(SessionTable, eq(SessionMessageTable.session_id, SessionTable.id))
    .where(
      and(
        inArray(SessionMessageTable.type, ["user", "assistant"]),
        input.from === undefined ? undefined : gte(SessionMessageTable.time_created, input.from),
        input.to === undefined ? undefined : lt(SessionMessageTable.time_created, input.to),
        input.projectID === undefined ? undefined : eq(SessionTable.project_id, input.projectID),
      ),
    )
    .all()
    .pipe(Effect.orDie)
  const sessionIDs = [...new Set(rows.map((row) => row.sessionID))]
  const events = (yield* Effect.forEach(
    Array.from({ length: Math.ceil(sessionIDs.length / 500) }, (_, index) =>
      sessionIDs.slice(index * 500, (index + 1) * 500),
    ),
    (batch) =>
      db
        .select({
          created: EventTable.created,
          data: EventTable.data,
        })
        .from(EventTable)
        .where(
          and(
            inArray(EventTable.aggregate_id, batch),
            eq(EventTable.type, SessionEvent.UsageRecorded.type),
            input.from === undefined ? undefined : gte(EventTable.created, input.from),
            input.to === undefined ? undefined : lt(EventTable.created, input.to),
          ),
        )
        .all()
        .pipe(Effect.orDie),
    { concurrency: 4 },
  )).flat()

  const sessions = new Set<string>()
  const subagents = new Set<string>()
  const activity = new Map<string, number>()
  const models = new Map<string, ModelAggregate>()
  const tools = new Map<string, ToolAggregate>()
  const totals = {
    prompts: 0,
    steps: 0,
    tokens: emptyTokens(),
    cost: 0,
    tools: { calls: 0, succeeded: 0, failed: 0, unfinished: 0 },
  }
  const dateKey = makeDateKey(input.timezone)

  rows.forEach((row) => {
    const decoded = decodeMessage({ ...row.data, id: row.id, type: row.type })
    if (Option.isNone(decoded)) return
    const message = decoded.value
    if (row.parentID) subagents.add(row.sessionID)
    else sessions.add(row.sessionID)

    if (message.type === "user") {
      if (!row.parentID) totals.prompts++
      return
    }
    if (message.type !== "assistant") return

    totals.steps++
    const tokens = message.tokens ?? emptyTokens()
    const cost = message.cost ?? 0
    addTokens(totals.tokens, tokens)
    totals.cost += cost
    const day = dateKey(DateTime.toEpochMillis(message.time.created))
    activity.set(day, (activity.get(day) ?? 0) + 1)

    const modelKey = `${message.model.providerID}/${message.model.id}#${message.model.variant ?? ""}`
    const model = models.get(modelKey) ?? { model: message.model, steps: 0, tokens: emptyTokens(), cost: 0 }
    models.set(modelKey, model)
    model.steps++
    model.cost += cost
    addTokens(model.tokens, tokens)

    message.content
      .filter((content): content is SessionMessage.AssistantTool => content.type === "tool")
      .forEach((content) => {
        const tool = tools.get(content.name) ?? {
          name: content.name,
          calls: 0,
          succeeded: 0,
          failed: 0,
          unfinished: 0,
          durations: [],
        }
        tools.set(content.name, tool)
        tool.calls++
        totals.tools.calls++
        if (content.state.status === "completed") {
          tool.succeeded++
          totals.tools.succeeded++
        } else if (content.state.status === "error") {
          tool.failed++
          totals.tools.failed++
        } else {
          tool.unfinished++
          totals.tools.unfinished++
        }
        if (content.time.completed === undefined) return
        tool.durations.push(
          DateTime.toEpochMillis(content.time.completed) -
            DateTime.toEpochMillis(content.time.ran ?? content.time.created),
        )
      })
  })

  events.forEach((row) => {
    const decoded = decodeUsage(row.data)
    if (Option.isNone(decoded)) return
    addTokens(totals.tokens, decoded.value.tokens)
    totals.cost += decoded.value.cost
  })

  const days = [...activity.entries()].sort(([a], [b]) => a.localeCompare(b))
  const now = Date.now()
  const fallback = input.to ?? now
  const earliestMessage = rows.reduce((earliest, row) => Math.min(earliest, row.timeCreated), fallback)
  const earliest = events.reduce((value, event) => Math.min(value, event.created), earliestMessage)
  const from = input.from ?? earliest
  const to = input.to ?? now

  return {
    range: { from: DateTime.makeUnsafe(from), to: DateTime.makeUnsafe(to) },
    sessions: sessions.size,
    subagents: subagents.size,
    prompts: totals.prompts,
    steps: totals.steps,
    tokens: totals.tokens,
    cost: Money.USD.make(totals.cost),
    tools: totals.tools,
    activeDays: days.length,
    streak: longestStreak(days.map(([date]) => date)),
    activity: days.map(([date, steps]) => ({ date, steps })),
    models: [...models.values()]
      .sort((a, b) => tokenTotal(b.tokens) - tokenTotal(a.tokens))
      .map((model) => ({ ...model, cost: Money.USD.make(model.cost) })),
    toolUsage: [...tools.values()]
      .sort((a, b) => b.calls - a.calls)
      .map((tool) => ({
        name: tool.name,
        calls: tool.calls,
        succeeded: tool.succeeded,
        failed: tool.failed,
        unfinished: tool.unfinished,
        durationP50: median(tool.durations),
      })),
  }
})

function emptyTokens(): Tokens {
  return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
}

function addTokens(target: Tokens, source: Tokens) {
  target.input += source.input
  target.output += source.output
  target.reasoning += source.reasoning
  target.cache.read += source.cache.read
  target.cache.write += source.cache.write
}

function tokenTotal(tokens: Tokens) {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

function makeDateKey(timezone = "UTC") {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
  return (time: number) => {
    const parts = Object.fromEntries(formatter.formatToParts(time).map((part) => [part.type, part.value]))
    return `${parts.year}-${parts.month}-${parts.day}`
  }
}

function longestStreak(days: string[]) {
  return days.reduce(
    (result, day, index) => {
      const previous = days[index - 1]
      const current = previous && dayOrdinal(day) - dayOrdinal(previous) === 1 ? result.current + 1 : 1
      return { current, longest: Math.max(result.longest, current) }
    },
    { current: 0, longest: 0 },
  ).longest
}

function dayOrdinal(value: string) {
  const [year, month, day] = value.split("-").map(Number)
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000)
}

function median(values: number[]) {
  if (values.length === 0) return undefined
  const sorted = values.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}
