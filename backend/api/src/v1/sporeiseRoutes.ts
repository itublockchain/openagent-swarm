import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import crypto from 'node:crypto'
import { ethers } from 'ethers'
import { apiKeyAuth } from './apiKeyAuth'
import type { KeyStore } from './keystore'
import type { IStoragePort } from '../../../../shared/ports'
import { SporeiseStore } from './sporeiseStore'
import {
  SporeiseRegistrar,
  SporeiseTaskRunner,
  isSporeFail,
  type RunnerInvoker,
  type RunnerEventEmitter,
  type SporeiseEvent,
} from '../SporeiseRunner'
import { formatUsdc } from '../lib/gasMeter'

/**
 * /v1/sporeise/* — managed-mode endpoints for the SDK's `Spore` class.
 *
 *   POST /v1/sporeise/register   — register a batch of agents (mints
 *                                   ephemeral on-chain EOAs, debits gas
 *                                   from Treasury). Idempotent per
 *                                   (userAddress, agent_label).
 *   GET  /v1/sporeise/agents     — list this user's registered agents.
 *   POST /v1/sporeise/tasks      — kick off a task; returns 202 with the
 *                                   server-issued task id.
 *   GET  /v1/sporeise/ws         — bidirectional WebSocket. SDK sends
 *                                   {type: 'result' | 'error'}; server
 *                                   sends {type: 'invoke' | 'event' | 'error'}.
 *
 * Auth: same Bearer-API-key surface every other /v1/* route uses.
 * The WebSocket expects the key in the `key` query string.
 */

// ─── Per-user WS hub ────────────────────────────────────────────────

interface WsConnection {
  socket: any  // ws.WebSocket
  // correlation_id → { resolve, reject } for outstanding invoke calls.
  pending: Map<string, { resolve: (value: any) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>
}

/** One WebSocket per user address. Multiple SDK processes from the same
 *  user MAY connect concurrently — last-writer-wins for the active
 *  socket; old sockets stay alive but stop receiving invokes. Production
 *  should track a queue per user; for the demo a single socket is fine. */
class WsHub implements RunnerEventEmitter {
  private byUser = new Map<string, WsConnection>()
  // taskId → userAddress so events can route back when the task isn't
  // tied to a single connection in a long-running setting.
  private taskOwner = new Map<string, string>()

  attach(userAddress: string, socket: any): void {
    const existing = this.byUser.get(userAddress)
    if (existing) {
      // Reject existing pendings — caller will retry on new socket.
      for (const [, p] of existing.pending) {
        clearTimeout(p.timer)
        p.reject(new Error('WS replaced by a newer connection'))
      }
      try { existing.socket.close(1000, 'replaced') } catch {}
    }
    this.byUser.set(userAddress, { socket, pending: new Map() })
  }

  /** Detach by socket identity, NOT just by user. Critical to avoid the
   *  race where a fresh WS attaches before the OLD socket's close event
   *  fires — naive `byUser.delete(user)` on the late close would wipe
   *  the new entry, dropping any in-flight task_completed event. */
  detach(userAddress: string, socket: any): void {
    const conn = this.byUser.get(userAddress)
    if (!conn) return
    if (conn.socket !== socket) {
      // Stale close event from a socket that's already been replaced.
      // The new socket's pendings + entry MUST stay intact.
      return
    }
    for (const [, p] of conn.pending) {
      clearTimeout(p.timer)
      p.reject(new Error('WS connection closed'))
    }
    this.byUser.delete(userAddress)
  }

  /** Register a task ↔ user binding so emit() can find the right socket
   *  after a reconnect. */
  bindTask(taskId: string, userAddress: string): void {
    this.taskOwner.set(taskId, userAddress)
  }

  unbindTask(taskId: string): void {
    this.taskOwner.delete(taskId)
  }

  emit(taskId: string, event: SporeiseEvent): void {
    const userAddress = this.taskOwner.get(taskId)
    if (!userAddress) return
    const conn = this.byUser.get(userAddress)
    if (!conn) {
      // No active WS — this happens when the SDK disconnects mid-task.
      // Log loudly so we don't silently lose terminal events like
      // task_completed / task_failed (the only other surface the user
      // has is the run() promise, which would otherwise hang to its
      // timeout).
      console.warn(
        `[sporeise/ws] dropping ${event.kind} for task=${taskId.slice(0, 8)} — no active WS for user ${userAddress.slice(0, 12)}…`,
      )
      return
    }
    safeSend(conn.socket, { type: 'event', task_id: taskId, event })
  }

  /** RPC into the SDK process. Returns the SDK's `result` payload, or
   *  rejects on error / timeout / disconnect. */
  invoke<T = any>(userAddress: string, payload: any, timeoutMs = 90_000): Promise<T> {
    return new Promise((resolve, reject) => {
      const conn = this.byUser.get(userAddress)
      if (!conn) {
        reject(new Error(`SDK not connected for ${userAddress}`))
        return
      }
      const correlationId = crypto.randomUUID()
      const timer = setTimeout(() => {
        conn.pending.delete(correlationId)
        reject(new Error(`SDK invoke ${payload?.kind} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      conn.pending.set(correlationId, { resolve, reject, timer })
      safeSend(conn.socket, { type: 'invoke', correlation_id: correlationId, ...payload })
    })
  }

  /** Called by the WS message handler when the SDK posts a `result` or
   *  correlated `error`. Resolves the matching pending invoke. */
  resolvePending(userAddress: string, correlationId: string, result: any, isError: boolean): void {
    const conn = this.byUser.get(userAddress)
    if (!conn) return
    const pending = conn.pending.get(correlationId)
    if (!pending) return
    clearTimeout(pending.timer)
    conn.pending.delete(correlationId)
    if (isError) pending.reject(new Error(typeof result?.message === 'string' ? result.message : 'SDK reported error'))
    else pending.resolve(result)
  }
}

function safeSend(socket: any, msg: unknown): void {
  try {
    if (socket?.readyState === 1) socket.send(JSON.stringify(msg))
  } catch (err) {
    console.warn('[sporeise/ws] send failed:', err)
  }
}

// ─── Body schemas ───────────────────────────────────────────────────

const RegisterBody = z.object({
  agents: z.array(
    z.object({
      id: z.string().trim().min(1).max(64),
      description: z.string().max(500).optional(),
      model: z.string().max(120).optional(),
    }),
  ).min(1).max(50),
})

const RunBody = z.object({
  spec: z.string().trim().min(1).max(4_000),
  validation: z.literal('next-worker').optional(),
  timeout_ms: z.number().int().positive().max(30 * 60_000).optional(),
  /** SDK-supplied filter: only use agents whose label is in this list.
   *  Empty / omitted → use everything listForUser returns. */
  agent_ids: z.array(z.string().trim().min(1)).max(50).optional(),
})

// ─── Route registrar ────────────────────────────────────────────────

interface RegisterOpts {
  keyStore: KeyStore
  storage: IStoragePort
  /** Single hub instance shared across REST + WS so the runner can
   *  emit() into it. */
  hub?: WsHub
  /** Optional override of the SQLite path; defaults to the same
   *  api.db every other /v1/* store opens. */
  dbPath?: string
}

export async function registerSporeiseRoutes(app: FastifyInstance, opts: RegisterOpts) {
  const auth = apiKeyAuth({ keyStore: opts.keyStore })
  const store = new SporeiseStore({ dbPath: opts.dbPath })
  const registrar = new SporeiseRegistrar(store)
  const hub = opts.hub ?? new WsHub()

  // Invoker fans /v1/sporeise/tasks calls back into the SDK process over
  // the hub's WS. The user-address binding for a given task is set in
  // the POST handler via `hub.bindTask` and torn down on completion.
  const invoker: RunnerInvoker = {
    async invokePlan(agentId: string, taskId: string, spec: string) {
      const userAddress = hubUserForTask(hub, taskId)
      const res = await hub.invoke<{ kind: 'plan'; subtasks: Array<{ id: string; spec: string }> }>(
        userAddress,
        { task_id: taskId, agent_id: agentId, kind: 'plan', payload: { kind: 'plan', spec } },
      )
      return { subtasks: res.subtasks ?? [] }
    },
    async invokeExecute(agentId: string, taskId: string, nodeId: string, subtask: string, context: string | null) {
      const userAddress = hubUserForTask(hub, taskId)
      const res = await hub.invoke<{ kind: 'execute'; output: string }>(
        userAddress,
        {
          task_id: taskId, agent_id: agentId, kind: 'execute',
          payload: { kind: 'execute', subtask, context, node_id: nodeId },
        },
      )
      return { output: res.output ?? '' }
    },
    async invokeJudge(agentId: string, taskId: string, nodeId: string, subtask: string, output: string) {
      const userAddress = hubUserForTask(hub, taskId)
      const res = await hub.invoke<{ kind: 'judge'; valid: boolean; reason?: string }>(
        userAddress,
        {
          task_id: taskId, agent_id: agentId, kind: 'judge',
          payload: { kind: 'judge', subtask, output, node_id: nodeId },
        },
      )
      return { valid: !!res.valid, reason: res.reason }
    },
  }

  // ─── POST /v1/sporeise/register ─────────────────────────────────────
  app.post('/v1/sporeise/register', { onRequest: [auth] }, async (request, reply) => {
    const ctx = request.apiKey!
    const parsed = RegisterBody.safeParse(request.body)
    if (!parsed.success) {
      reply.status(400).send({ error: 'Invalid body', issues: parsed.error.issues })
      return
    }
    try {
      const result = await registrar.registerMany(ctx.userAddress, parsed.data.agents)
      const all = [...result.existing, ...result.fresh]
      reply.send({
        agents: all.map(a => ({
          id: a.id,
          agent_label: a.agentLabel,
          agent_address: a.agentAddress,
          description: a.description,
          model: a.model,
          registered_at: a.createdAt,
        })),
        gas_charged: formatUsdc(result.gasChargedWei),
        balance_remaining: formatUsdc(result.balanceAfterWei),
      })
    } catch (err) {
      const msg = (err as Error).message
      console.error('[sporeise/register] failed:', err)
      const status = msg.includes('not configured') ? 503 : 500
      reply.status(status).send({ error: msg, code: 'REGISTER_FAILED' })
    }
  })

  // ─── GET /v1/sporeise/agents ────────────────────────────────────────
  app.get('/v1/sporeise/agents', { onRequest: [auth] }, async (request, reply) => {
    const ctx = request.apiKey!
    const agents = store.listForUser(ctx.userAddress)
    reply.send({
      agents: agents.map(a => ({
        id: a.id,
        agent_label: a.agentLabel,
        agent_address: a.agentAddress,
        description: a.description,
        model: a.model,
        created_at: a.createdAt,
      })),
    })
  })

  // ─── POST /v1/sporeise/tasks ────────────────────────────────────────
  app.post('/v1/sporeise/tasks', { onRequest: [auth] }, async (request, reply) => {
    const ctx = request.apiKey!
    const parsed = RunBody.safeParse(request.body)
    if (!parsed.success) {
      reply.status(400).send({ error: 'Invalid body', issues: parsed.error.issues })
      return
    }
    const allAgents = store.listForUser(ctx.userAddress)
    if (allAgents.length === 0) {
      reply.status(400).send({ error: 'No agents registered — call /v1/sporeise/register first', code: 'NO_AGENTS' })
      return
    }
    // SDK-supplied filter: scope the run to the labels the caller knows
    // about. Without this, a user with stale historic registrations gets
    // their old agents picked as planner — and the SDK can't route the
    // resulting WS invokes back to a local instance ("Unknown agent id").
    const filterSet = parsed.data.agent_ids && parsed.data.agent_ids.length > 0
      ? new Set(parsed.data.agent_ids)
      : null
    const agents = filterSet
      ? allAgents.filter(a => filterSet.has(a.agentLabel))
      : allAgents
    if (agents.length === 0) {
      reply.status(400).send({
        error: `Filter agent_ids matched no registered agents. Registered: [${allAgents.map(a => a.agentLabel).join(', ')}]; requested: [${[...filterSet!].join(', ')}]`,
        code: 'NO_MATCHING_AGENTS',
      })
      return
    }

    const taskId = crypto.randomUUID()
    const taskIdBytes32 = ethers.keccak256(ethers.toUtf8Bytes(taskId))
    hub.bindTask(taskId, ctx.userAddress)

    // Async dispatch — return 202 immediately; events flow over WS.
    const runner = new SporeiseTaskRunner(store, opts.storage, invoker, hub)
    const timeoutMs = parsed.data.timeout_ms ?? 5 * 60_000
    runner
      .run({
        taskId,
        spec: parsed.data.spec,
        userAddress: ctx.userAddress,
        agents,
        timeoutMs,
      })
      .then(() => {
        // task_completed already emitted inside run() — just clean up.
        hub.unbindTask(taskId)
      })
      .catch(err => {
        const phase = isSporeFail(err) ? err.phase : 'unknown'
        const reason = (err as Error).message
        console.error(`[sporeise/run] task ${taskId} failed at ${phase}:`, reason)
        hub.emit(taskId, { kind: 'task_failed', reason, phase })
        hub.unbindTask(taskId)
      })

    reply.status(202).send({
      task_id: taskId,
      task_id_bytes32: taskIdBytes32,
      status: 'accepted',
    })
  })

  // ─── WS /v1/sporeise/ws ─────────────────────────────────────────────
  // Auth via ?key=<plaintext> (Sec-WebSocket-Protocol can carry it too).
  app.get('/v1/sporeise/ws', { websocket: true }, (connection: any, req: any) => {
    const socket = connection.socket || connection
    const url = new URL(req.url, `http://${req.headers.host}`)
    const apiKey = url.searchParams.get('key') || ''
    if (!apiKey) {
      try { socket.send(JSON.stringify({ type: 'error', message: 'Missing API key (?key=)', code: 'MISSING_KEY' })) } catch {}
      try { socket.close(4401, 'unauthorized') } catch {}
      return
    }
    const ctx = opts.keyStore.lookup(apiKey)
    if (!ctx) {
      try { socket.send(JSON.stringify({ type: 'error', message: 'Invalid API key', code: 'INVALID_KEY' })) } catch {}
      try { socket.close(4401, 'unauthorized') } catch {}
      return
    }
    const userAddress = ctx.userAddress
    hub.attach(userAddress, socket)
    console.log(`[sporeise/ws] connected user=${userAddress.slice(0, 12)}…`)

    socket.on('message', (raw: any) => {
      let msg: any
      try { msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf-8')) } catch {
        return
      }
      if (msg?.type === 'result' && typeof msg.correlation_id === 'string') {
        hub.resolvePending(userAddress, msg.correlation_id, msg.payload, false)
      } else if (msg?.type === 'error' && typeof msg.correlation_id === 'string') {
        hub.resolvePending(userAddress, msg.correlation_id, msg, true)
      } else if (msg?.type === 'error') {
        // Top-level (uncorrelated) error — log only.
        console.warn(`[sporeise/ws] uncorrelated client error from ${userAddress.slice(0, 12)}…:`, msg.message)
      }
    })
    socket.on('close', () => {
      hub.detach(userAddress, socket)
      console.log(`[sporeise/ws] disconnected user=${userAddress.slice(0, 12)}…`)
    })
    socket.on('error', (err: any) => {
      console.warn(`[sporeise/ws] socket error for ${userAddress.slice(0, 12)}…:`, err?.message ?? err)
    })
  })

  console.log('[API] /v1/sporeise/* routes mounted')
}

function hubUserForTask(hub: WsHub, taskId: string): string {
  // Tiny accessor — keeps WsHub.invoke signature uniform across kinds.
  // Throws if no binding (which would mean the task was unbound before
  // the runner finished — programming bug, surface loudly).
  const userAddress = (hub as any).taskOwner.get(taskId) as string | undefined
  if (!userAddress) throw new Error(`SporeiseRunner: no WS binding for task ${taskId}`)
  return userAddress
}
