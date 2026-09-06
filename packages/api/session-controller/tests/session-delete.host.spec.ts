/**
 * Session Controller deletion: header resolution (attached or persisted),
 * subagent-ownership refusal, live Agent release before the stored log is
 * destroyed, and the fail-soft cleanup of the projection-cache row and
 * workspace accounting. The Agent factory is a structural stub whose handle
 * dispose unregisters the agent (emitting agent/disposed); remote-proxy-cold
 * owns the real resume evidence.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import SessionController from '../src/index.ts'
import {
  createSessionTestRemote,
  testSessionPersistence,
} from './test-remote.ts'

const sid = (id: string): SessionId => id as SessionId

function request<P>(payload: P): P {
  return payload
}

function header(id: string, createdAt: number, extra: Partial<SessionHeader> = {}): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: sid(id), createdAt, isSeeded: false, cwd: '/proj', ...extra }
}

interface Doubles {
  persistenceDelete: ReturnType<typeof vi.fn>
  projcacheRemove: ReturnType<typeof vi.fn>
  registryRemoveSession: ReturnType<typeof vi.fn>
  removed: ReturnType<typeof vi.fn>
  disposals: Map<SessionId, ReturnType<typeof vi.fn>>
}

async function composed(metas: SessionHeader[] = []): Promise<{ ctx: Context; doubles: Doubles }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  const listed = [...metas]
  const persistenceDelete = vi.fn(async (id: SessionId): Promise<boolean> => {
    const at = listed.findIndex(meta => meta.id === id)
    if (at === -1) return false
    listed.splice(at, 1)
    return true
  })
  ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
    list: () => Promise.resolve([...listed]),
    inspect: async (id: SessionId): Promise<{ meta: SessionHeader; events: readonly SessionEvent[] } | undefined> => {
      const meta = listed.find(item => item.id === id)
      return meta === undefined ? undefined : { meta, events: [] }
    },
    delete: persistenceDelete,
  }) as never)
  const projcacheRemove = vi.fn(async (_id: SessionId): Promise<void> => {})
  ctx.provide('sessionProjectionCache', { remove: projcacheRemove } as never)
  const registryRemoveSession = vi.fn(async (_id: SessionId): Promise<boolean> => true)
  ctx.provide('workspaceRegistry', {
    get: () => undefined,
    list: () => [],
    removeSession: registryRemoveSession,
  } as never)
  const disposals = new Map<SessionId, ReturnType<typeof vi.fn>>()
  ctx.agents.setFactory({
    createAgent: (ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> => {
      const session = ownerCtx.sessions.create(options.sessionId, {
        ...options.meta === undefined ? {} : { meta: options.meta },
      })
      const agent = { id: session.id, session, status: 'idle', ctx: ownerCtx } as Agent
      const unregister = ownerCtx.agents.register(agent)
      const dispose = vi.fn(() => {
        unregister()
        return Promise.resolve()
      })
      disposals.set(session.id, dispose)
      return Promise.resolve({ agent, dispose })
    },
    resume: () => Promise.reject(new Error('resume must not run: every source here is created')),
  })
  const removed = vi.fn()
  ctx.on('api-session/removed', removed)
  return { ctx, doubles: { persistenceDelete, projcacheRemove, registryRemoveSession, removed, disposals } }
}

const remote = (ctx: Context) => createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })

describe('sessions.delete', () => {
  it('declares the fiber services the deletion path reads by property', () => {
    // Property reads inside the controller fiber require a matching `static
    // inject` entry; a missing name throws `cannot get property "…" without
    // inject` only in a real composition (docs/postmortem/0001).
    const declared = SessionController.inject
    for (const required of ['agents', 'sessions', 'sessionPersistence', 'sessionProjectionCache', 'workspaceRegistry']) {
      expect(declared).toContain(required)
    }
  })

  it('destroys the stored log, drops the cache row and workspace accounting, and emits the removal once', async () => {
    const { ctx, doubles } = await composed([header('cold-delete', 100)])
    const id = sid('cold-delete')

    const response = await remote(ctx).delete(request({ sessionId: id }))
    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.value).toEqual({ deleted: true })
    expect(doubles.persistenceDelete).toHaveBeenCalledExactlyOnceWith(id)
    expect(doubles.projcacheRemove).toHaveBeenCalledExactlyOnceWith(id)
    expect(doubles.registryRemoveSession).toHaveBeenCalledExactlyOnceWith(id)
    expect(doubles.removed).toHaveBeenCalledExactlyOnceWith(id)

    // The repeat finds no attached or persisted header.
    const again = await remote(ctx).delete(request({ sessionId: id }))
    expect(again.ok).toBe(false)
    if (!again.ok) {
      expect(again.error).toMatchObject({ code: 'session/not-found', details: { sessionId: id } })
    }
    expect(doubles.persistenceDelete).toHaveBeenCalledTimes(1)
  })

  it('refuses an unknown session before touching any cleanup service', async () => {
    const { ctx, doubles } = await composed([header('other', 100)])

    const response = await remote(ctx).delete(request({ sessionId: sid('ghost-delete') }))
    expect(response.ok).toBe(false)
    if (!response.ok) {
      expect(response.error).toMatchObject({
        code: 'session/not-found',
        details: { sessionId: 'ghost-delete' },
      })
      expect(response.error.message).toBe('session "ghost-delete" does not exist')
    }
    expect(doubles.persistenceDelete).not.toHaveBeenCalled()
    expect(doubles.projcacheRemove).not.toHaveBeenCalled()
    expect(doubles.registryRemoveSession).not.toHaveBeenCalled()
    expect(doubles.removed).not.toHaveBeenCalled()
  })

  it('refuses a subagent-owned session before disposal or deletion', async () => {
    const { ctx, doubles } = await composed([
      header('subagent-child', 100, { origin: 'subagent' }),
    ])

    const response = await remote(ctx).delete(request({ sessionId: sid('subagent-child') }))
    expect(response.ok).toBe(false)
    if (!response.ok) {
      expect(response.error).toMatchObject({
        code: 'session/agent-busy',
        details: { reason: 'use subagent delivery for this child session' },
      })
    }
    expect(doubles.persistenceDelete).not.toHaveBeenCalled()
    expect(doubles.projcacheRemove).not.toHaveBeenCalled()
    expect(doubles.registryRemoveSession).not.toHaveBeenCalled()
    expect(doubles.removed).not.toHaveBeenCalled()
  })

  it('disposes the live Agent before destroying the log', async () => {
    const { ctx, doubles } = await composed()
    const created = await remote(ctx).create(request({}))
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const id = created.value.sessionId
    expect(ctx.sessions.get(id)).toBeDefined()
    expect(ctx.agents.get(id)).toBeDefined()
    const dispose = doubles.disposals.get(id)
    if (dispose === undefined) throw new Error('created session has no tracked Agent handle')

    const response = await remote(ctx).delete(request({ sessionId: id }))
    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.value).toEqual({ deleted: true })
    // The Agent was stopped first: unregistered, its handle disposed.
    expect(dispose).toHaveBeenCalledOnce()
    expect(ctx.agents.get(id)).toBeUndefined()
    expect(doubles.persistenceDelete).toHaveBeenCalledExactlyOnceWith(id)
    expect(doubles.projcacheRemove).toHaveBeenCalledExactlyOnceWith(id)
    expect(doubles.registryRemoveSession).toHaveBeenCalledExactlyOnceWith(id)
    expect(doubles.removed).toHaveBeenCalledExactlyOnceWith(id)
  })

  it('propagates a persistence deletion failure without emitting or cleaning up', async () => {
    const { ctx, doubles } = await composed([header('disk-gone', 100)])
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    doubles.persistenceDelete.mockRejectedValueOnce(new Error('disk gone'))
    const id = sid('disk-gone')

    const response = await remote(ctx).delete(request({ sessionId: id }))
    expect(response.ok).toBe(false)
    if (!response.ok) expect(response.error.code).toBe('gateway/internal')
    expect(doubles.projcacheRemove).not.toHaveBeenCalled()
    expect(doubles.registryRemoveSession).not.toHaveBeenCalled()
    expect(doubles.removed).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('survives a failed projection-cache row drop with a warn', async () => {
    const { ctx, doubles } = await composed([header('cache-down', 100)])
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    doubles.projcacheRemove.mockRejectedValueOnce(new Error('cache medium down'))
    const id = sid('cache-down')

    const response = await remote(ctx).delete(request({ sessionId: id }))
    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('projection-cache row for "cache-down" was not removed'))
    expect(doubles.registryRemoveSession).toHaveBeenCalledExactlyOnceWith(id)
    expect(doubles.removed).toHaveBeenCalledExactlyOnceWith(id)
  })

  it('survives a failed workspace accounting removal with a warn', async () => {
    const { ctx, doubles } = await composed([header('registry-down', 100)])
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    doubles.registryRemoveSession.mockRejectedValueOnce(new Error('registry medium down'))
    const id = sid('registry-down')

    const response = await remote(ctx).delete(request({ sessionId: id }))
    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('workspace accounting for "registry-down" was not removed'))
    expect(doubles.removed).toHaveBeenCalledExactlyOnceWith(id)
  })
})
