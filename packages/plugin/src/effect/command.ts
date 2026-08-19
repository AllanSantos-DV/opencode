import type { CommandApi } from "@opencode-ai/client/effect/api"
import type { Session } from "@opencode-ai/schema/session"
import type { Effect, Scope } from "effect"
import type { Registration } from "./registration.js"

export interface CommandInvocation {
  readonly sessionID: Session.ID
  readonly arguments: string
}

export interface CommandDefinition {
  readonly name: string
  readonly description?: string
  readonly run: (input: CommandInvocation) => Effect.Effect<void>
}

export interface CommandDomain extends Pick<CommandApi<unknown>, "list"> {
  readonly register: (definition: CommandDefinition) => Effect.Effect<Registration, never, Scope.Scope>
}
