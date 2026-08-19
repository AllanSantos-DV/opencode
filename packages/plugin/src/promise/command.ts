import type { CommandApi } from "@opencode-ai/client/promise/api"
import type { Session } from "@opencode-ai/schema/session"
import type { Registration } from "./registration.js"

export interface CommandInvocation {
  readonly sessionID: Session.ID
  readonly arguments: string
}

export interface CommandDefinition {
  readonly name: string
  readonly description?: string
  readonly run: (input: CommandInvocation) => Promise<void>
}

export interface CommandDomain extends Pick<CommandApi, "list"> {
  readonly register: (definition: CommandDefinition) => Promise<Registration>
}
