import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Command } from "@opencode-ai/core/command"
import { Config } from "@opencode-ai/core/config"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Location } from "@opencode-ai/core/location"
import { MCP } from "@opencode-ai/core/mcp/index"
import { Model } from "@opencode-ai/core/model"
import { Provider } from "@opencode-ai/core/provider"
import { Session } from "@opencode-ai/schema/session"
import { emptyConfigLayer, emptyMcpLayer, testLocationLayer } from "./fixture/mcp"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(Command.node, [
    [MCP.node, emptyMcpLayer],
    [Config.node, emptyConfigLayer],
    [Location.node, testLocationLayer],
  ]),
)

describe("Command", () => {
  it.effect("registers and executes callback commands", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      const calls: Command.Invocation[] = []
      yield* command.transform((draft) => {
        draft.add({
          name: "goal",
          description: "Manage the session goal",
          run: (input) => Effect.sync(() => calls.push(input)),
        })
      })

      expect(yield* command.get("goal")).toEqual(
        Command.Info.make({ name: "goal", template: "", description: "Manage the session goal" }),
      )
      const invocation = { sessionID: Session.ID.make("ses_test"), arguments: "ship it", delivery: "steer" as const }
      yield* command.execute({ name: "goal", invocation })
      expect(calls).toEqual([invocation])
    }),
  )

  it.effect("applies command transforms and preserves later overrides", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      yield* command.transform((editor) => {
        editor.update("review", (command) => {
          command.template = "First"
          command.description = "Review code"
        })
        editor.update("review", (command) => {
          command.template = "Second"
          command.model = {
            id: Model.ID.make("claude"),
            providerID: Provider.ID.make("anthropic"),
            variant: Model.VariantID.make("high"),
          }
        })
      })

      expect(yield* command.get("review")).toEqual(
        Command.Info.make({
          name: "review",
          template: "Second",
          description: "Review code",
          model: {
            id: Model.ID.make("claude"),
            providerID: Provider.ID.make("anthropic"),
            variant: Model.VariantID.make("high"),
          },
        }),
      )
      expect(yield* command.list()).toEqual([
        Command.Info.make({
          name: "review",
          template: "Second",
          description: "Review code",
          model: {
            id: Model.ID.make("claude"),
            providerID: Provider.ID.make("anthropic"),
            variant: Model.VariantID.make("high"),
          },
        }),
      ])
    }),
  )

  it.effect("evaluates command template shell blocks", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      yield* command.transform((editor) => {
        editor.update("review", (command) => {
          command.template = "Output: !`echo command-output`"
        })
      })

      expect((yield* command.evaluate({ name: "review" })).text.replace(/\r?\n$/, "")).toEqual("Output: command-output")
    }),
  )
})
