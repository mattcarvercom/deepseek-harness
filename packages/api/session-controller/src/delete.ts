/** Durable, unrecoverable Session deletion: live Agent release, storage removal, list publication. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import type {} from '@deepseek-ai/dsh-workspace'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import {
  ApiSessionAgentController,
  hasApiSessionSubagentOwner,
  apiSessionSubagentOwnershipError,
} from './agent.ts'
import type { SessionDeleteRequest, SessionDeleteValue } from './types.ts'

/** Owns the Session deletion lifecycle across Agent, persistence, cache, and registry. */
export class SessionDeleteController {
  /**
   * @param ctx - Host context carrying Session, persistence, cache, and registry services.
   * @param agents - the Agent controller that releases the live Agent first.
   */
  constructor(
    private readonly ctx: Context,
    private readonly agents: ApiSessionAgentController,
  ) {}

  /**
   * Permanently delete one Session: its persisted log is destroyed, its
   * projection-cache row is dropped, and its workspace-accounting ids are
   * stripped. The operation is not recoverable.
   *
   * A live Agent for the Session is disposed first (its running turn is
   * cancelled and `session/disposed` publishes the session leaving the
   * store); subagent-owned Sessions are refused, matching every other
   * Session command. `api-session/removed` is emitted only after the durable
   * deletion committed.
   * @param request - the Session to delete.
   * @returns the deletion receipt once every durable step committed.
   */
  async delete(request: SessionDeleteRequest): Promise<SessionDeleteValue> {
    const sessionId = request.sessionId
    const header = await this.headerFor(sessionId)
    const agent = this.ctx.agents.get(sessionId)
    if (hasApiSessionSubagentOwner(this.ctx, { header }, agent)) {
      throw apiSessionSubagentOwnershipError(sessionId)
    }
    await this.agents.disposeAgent(sessionId)
    // `false` marks a session that never materialized an artifact; its cache
    // row and any accounting id still need the same idempotent drops.
    await this.ctx.sessionPersistence.delete(sessionId)
    // The cache row is fail-soft derived data: a failed drop leaves an inert
    // row no cold read can serve (its log is gone), never a listed session.
    try {
      await this.ctx.sessionProjectionCache.remove(sessionId)
    } catch (error: unknown) {
      this.ctx.logger.warn(`session deletion: projection-cache row for "${sessionId}" was not removed: ${String(error)}`)
    }
    // A stale record id is inert for listing (the list is persistence-driven)
    // and pruned by the registry's next record mutation.
    try {
      await this.ctx.workspaceRegistry.removeSession(sessionId)
    } catch (error: unknown) {
      this.ctx.logger.warn(`session deletion: workspace accounting for "${sessionId}" was not removed: ${String(error)}`)
    }
    this.ctx.emit('api-session/removed', sessionId)
    return { deleted: true }
  }

  /**
   * The header of an attached or persisted Session; a definite miss is the
   * stable Session-domain failure, storage faults propagate as themselves.
   */
  private async headerFor(sessionId: SessionId): Promise<SessionHeader> {
    const attached = this.ctx.sessions.get(sessionId)
    if (attached !== undefined) return attached.header
    const snapshot = await this.ctx.sessionPersistence.stat(sessionId)
    if (snapshot === undefined) {
      throw new RemoteError('session/not-found', `session "${sessionId}" does not exist`, { sessionId })
    }
    return snapshot.header
  }
}
