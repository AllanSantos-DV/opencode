import { describe, expect, test } from "bun:test"
import { isPeakPricing } from "../src/routes/zen/util/pricing"

describe("isPeakPricing", () => {
  test.each([
    ["weekday first window starts", "2026-08-27T01:00:00.000Z", true],
    ["weekday first window ends", "2026-08-27T04:00:00.000Z", false],
    ["weekday second window starts", "2026-08-27T06:00:00.000Z", true],
    ["weekday second window ends", "2026-08-27T10:00:00.000Z", false],
    ["Saturday in Beijing", "2026-08-29T01:00:00.000Z", false],
    ["Sunday in Beijing", "2026-08-30T06:00:00.000Z", false],
    ["Monday in Beijing", "2026-08-31T01:00:00.000Z", true],
  ] as const)("handles %s", (_name, timestamp, expected) => {
    expect(isPeakPricing(new Date(timestamp))).toBe(expected)
  })
})
