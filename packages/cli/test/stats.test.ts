import { describe, expect, test } from "bun:test"
import type { SessionStatsInfo } from "@opencode-ai/client"
import { renderStats } from "../src/commands/handlers/stats"

const stats: SessionStatsInfo = {
  range: { from: Date.UTC(2026, 0, 1), to: Date.UTC(2026, 0, 8) },
  sessions: 2,
  subagents: 1,
  prompts: 4,
  steps: 6,
  tokens: { input: 10_000, output: 2_000, reasoning: 1_000, cache: { read: 5_000, write: 500 } },
  cost: 12.34,
  tools: { calls: 10, succeeded: 8, failed: 2, unfinished: 0 },
  activeDays: 2,
  streak: 2,
  activity: [
    { date: "2026-01-02", steps: 2 },
    { date: "2026-01-03", steps: 4 },
  ],
  models: [
    {
      model: { providerID: "anthropic", id: "sonnet" },
      steps: 6,
      tokens: { input: 10_000, output: 2_000, reasoning: 1_000, cache: { read: 5_000, write: 500 } },
      cost: 12.34,
    },
  ],
  toolUsage: [{ name: "private_tool", calls: 10, succeeded: 8, failed: 2, unfinished: 0, durationP50: 250 }],
}

describe("stats rendering", () => {
  test("keeps the default card shareable", () => {
    const output = renderStats(stats, options())
    expect(output).toContain("opencode stats · 2026 so far")
    expect(output).toContain("activity")
    expect(output).toContain("Mo ··")
    expect(output).toMatch(/Mo .*\n\nTu/)
    expect(output).toMatch(/Su .*\n\n   less/)
    expect(output).toContain("less ·░▒▓█ more")
    expect(output).toContain("2 sessions · 1 subagent")
    expect(output).toContain("80.0% tools · 2 active days · best streak 2 days")
    expect(output).not.toContain("private_tool")
    expect(output).not.toContain("$12.34")
  })

  test("renders only requested detail tables", () => {
    const output = renderStats(stats, options({ tools: true, cost: true }))
    expect(output).toContain("COST & TOKENS")
    expect(output).toContain("TOOL RELIABILITY")
    expect(output).toContain("private_tool")
    expect(output).toContain("tool")
    expect(output).toContain("calls")
    expect(output).not.toContain("opencode stats")
    expect(output).not.toContain("activity")
  })

  test("uses the OpenCode palette in color mode", () => {
    const output = renderStats(stats, options({ color: true }))
    expect(output).toContain("\x1b[1;38;2;")
    expect(output).not.toContain("38;5;45")
  })
})

function options(input: Partial<Parameters<typeof renderStats>[1]> = {}): Parameters<typeof renderStats>[1] {
  return {
    label: "2026 so far",
    models: false,
    tools: false,
    cost: false,
    limit: 5,
    color: false,
    ...input,
  }
}
