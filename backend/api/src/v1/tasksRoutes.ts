import type { FastifyInstance } from 'fastify'
import { ethers } from 'ethers'
import { z } from 'zod'
import { apiKeyAuth, requireScope } from './apiKeyAuth'
import { getTreasuryClient } from './chain'
import type { KeyStore } from './keystore'
import type { IStoragePort, INetworkPort } from '../../../../shared/ports'
import { EventType } from '../../../../shared/types'
import type { TaskIndex } from './tasksIndex'
import type { ColonyStore } from './colonyStore'

// Same shape as the legacy TaskSchema in ../schemas.ts but redefined here
// so v1 routes don't drift if the legacy schema gains user-flow-only
// fields. Tight intersection: keep these schemas behaviorally compatible.
const SubmitTaskBody = z.object({
  spec: z.string().trim().min(1).max(4_000),
  budget: z
    .string()
    .regex(/^\d+(\.\d+)?$/, 'budget must be a positive decimal string'),
  model: z.string().trim().max(120).optional(),
  metadata: z.record(z.unknown()).optional(),
  // Optional colony scope. snake_case in body to match the rest of the
  // SDK surface; we forward it as `colonyId` in the AXL payload (camelCase
  // is what SwarmAgent reads).
  colony_id: z.string().trim().min(1).optional(),
})

interface RegisterOpts {
  keyStore: KeyStore
  storage: IStoragePort
  network: INetworkPort
  /** In-memory taskId → node results map maintained by server.ts. Shared
   *  reference (not a copy) so /v1/tasks/:id/result returns the same data
   *  the legacy /result/:taskId reads. */
  taskResults: Map<string, { nodes: Array<{ nodeId: string; result: string }> }>
  /** Per-owner task index — populated on every successful SDK submit so
   *  the profile page can enumerate the user's history. */
  taskIndex: TaskIndex
  /** Colony lookup for the privacy gate on colony-scoped task submission. */
  colonyStore: ColonyStore
}

/**
 * Match server.ts: a specHash that already looks like a 0x-prefixed 32-byte
 * hex passes through; otherwise we keccak the storage hash to get bytes32.
 */
function deriveTaskId(specHash: string): string {
  return specHash.startsWith('0x') && specHash.length === 66
    ? specHash
    : ethers.keccak256(ethers.toUtf8Bytes(specHash))
}

/**
 * Mounts /v1/tasks/* — the SDK's main entry points. Submission spends from
 * the user's Treasury balance via operator-signed `spendOnBehalfOf`; reads
 * are public RPC.
 */
export async function registerTasksRoutes(app: FastifyInstance, opts: RegisterOpts) {
  const { keyStore, storage, network, taskResults, taskIndex, colonyStore } = opts
  const auth = apiKeyAuth({ keyStore })
  const submitGate = requireScope('tasks:submit')
  const readGate = requireScope('tasks:read')

  // ----------------------------------------------------------------
  // POST /v1/tasks
  app.post('/v1/tasks', { onRequest: [auth, submitGate] }, async (request, reply) => {
    const ctx = request.apiKey!
    const parse = SubmitTaskBody.safeParse(request.body)
    if (!parse.success) {
      reply.status(400).send({ error: 'Invalid body', issues: parse.error.issues })
      return
    }
    const body = parse.data

    const { readUsdc, readTreasury, writeTreasury, treasuryAddr, operatorAddress } = getTreasuryClient()
    if (!writeTreasury || !operatorAddress) {
      reply.status(503).send({
        error: 'Operator wallet not configured (PRIVATE_KEY missing)',
        code: 'OPERATOR_DOWN',
      })
      return
    }

    // 1. Resolve decimals + parse budget. Decimals call can fail when
    //    RPC is flaky — surface as a 502 so SDK retries with backoff.
    let decimals: number
    try {
      decimals = Number(await readUsdc.decimals())
    } catch {
      reply.status(502).send({ error: 'L2 RPC unreachable', code: 'RPC_DOWN' })
      return
    }
    let budgetWei: bigint
    try {
      budgetWei = ethers.parseUnits(body.budget, decimals)
    } catch {
      reply.status(400).send({ error: 'Invalid budget format' })
      return
    }
    if (budgetWei === 0n) {
      reply.status(400).send({ error: 'Budget must be > 0' })
      return
    }

    // 2. Persist spec → content-addressed storage hash. This becomes the
    //    public-facing taskId. taskIdBytes32 is the same hash padded for
    //    on-chain identification; identical specs collide deliberately.
    const specHash = await storage.append({
      spec: body.spec,
      budget: body.budget,
      model: body.model,
      metadata: body.metadata,
      submittedBy: ctx.userAddress,
      submittedVia: 'sdk',
      submittedAt: Date.now(),
    })
    const taskIdBytes32 = deriveTaskId(specHash)

    // 3. Pre-flight balance check off-chain so we 402 cleanly without
    //    paying gas. The on-chain spend has the authoritative check
    //    too — this is just nicer DX (clear error before tx submit).
    let balance: bigint
    try {
      balance = (await readTreasury.balanceOf(ctx.userAddress)) as bigint
    } catch {
      reply.status(502).send({ error: 'Treasury read failed', code: 'RPC_DOWN' })
      return
    }
    if (balance < budgetWei) {
      reply.status(402).send({
        error: 'Insufficient Treasury balance',
        code: 'INSUFFICIENT_BALANCE',
        balance: ethers.formatUnits(balance, decimals),
        required: body.budget,
      })
      return
    }

    // 4. Operator signs `spendOnBehalfOf`. Treasury enforces:
    //    - keyHash bound to user
    //    - key not frozen
    //    - balance >= amount
    //    - daily cap not exceeded
    //    On revert we surface the contract reason so SDK / dashboard can
    //    show "daily cap reached" vs "key frozen" distinctly.
    let txHash: string
    try {
      const tx = await writeTreasury.spendOnBehalfOf(
        ctx.userAddress,
        taskIdBytes32,
        budgetWei,
        ctx.chainKeyHash,
      )
      const receipt = await tx.wait()
      txHash = receipt?.hash ?? tx.hash
    } catch (err: unknown) {
      // ethers v6 surfaces `shortMessage`/`reason` for require() reverts.
      const e = err as { shortMessage?: string; reason?: string; message?: string }
      const reason = e.shortMessage ?? e.reason ?? e.message ?? 'unknown'
      const code = mapTreasuryRevert(reason)
      const status = code === 'CAP_EXHAUSTED' || code === 'INSUFFICIENT_BALANCE' ? 402 : 400
      reply.status(status).send({ error: reason, code })
      return
    }

    // 5. Re-read balance for the response so the SDK can show post-spend
    //    state without a follow-up /v1/balance call.
    let remaining: bigint
    try {
      remaining = (await readTreasury.balanceOf(ctx.userAddress)) as bigint
    } catch {
      remaining = balance - budgetWei // best-effort
    }

    // 5b. Colony scope authz. Done AFTER Treasury spend because the spend
    //     is the irreversible step — once budget moved, we want to actually
    //     dispatch. Private colony with non-owner caller still 403s here,
    //     but a refund mechanism would need explicit user action.
    //     (Frontend should validate visibility before submit; this is the
    //     server-side defence.)
    if (body.colony_id) {
      const colony = colonyStore.get(body.colony_id)
      if (!colony || colony.archivedAt) {
        reply.status(404).send({ error: 'Colony not found', code: 'COLONY_NOT_FOUND' })
        return
      }
      if (colony.visibility === 'private' && colony.owner !== ctx.userAddress.toLowerCase()) {
        reply.status(403).send({
          error: 'Colony is private — only its owner can submit tasks here',
          code: 'COLONY_PRIVATE',
        })
        return
      }
    }

    // 6. Broadcast to AXL — same payload shape the existing /task uses
    //    so workers/planners pick it up without any code change.
    await network.emit({
      type: EventType.TASK_SUBMITTED,
      payload: {
        spec: body.spec,
        budget: body.budget,
        model: body.model,
        metadata: body.metadata,
        taskId: specHash,
        specHash,
        submittedBy: ctx.userAddress,
        submittedVia: 'sdk',
        colonyId: body.colony_id,
      },
      timestamp: Date.now(),
      agentId: 'api-server',
    })

    // 7. Record in the owner-scoped index so the profile page can list
    //    this task. INSERT OR IGNORE — duplicate specHash collisions
    //    (re-submission of identical spec) keep the original row.
    taskIndex.record({
      taskId: specHash,
      owner: ctx.userAddress,
      spec: body.spec,
      budget: body.budget,
      source: 'sdk',
      model: body.model ?? null,
      colonyId: body.colony_id ?? null,
    })

    reply.status(202).send({
      task_id: specHash,
      task_id_bytes32: taskIdBytes32,
      status: 'pending',
      budget_locked: body.budget,
      balance_remaining: ethers.formatUnits(remaining, decimals),
      submitted_at: new Date().toISOString(),
      treasury_tx: txHash,
      treasury: treasuryAddr,
    })
  })

  // ----------------------------------------------------------------
  // GET /v1/tasks/:id
  app.get<{ Params: { id: string } }>('/v1/tasks/:id', { onRequest: [auth, readGate] }, async (request, reply) => {
    const { id } = request.params
    const stored = await storage.fetch(id).catch(() => null)
    if (!stored) {
      reply.status(404).send({ error: 'Task not found' })
      return
    }
    const result = taskResults.get(id) ?? null
    reply.send({
      task_id: id,
      status: result ? 'completed' : 'pending',
      spec: (stored as any).spec ?? null,
      budget: (stored as any).budget ?? null,
      model: (stored as any).model ?? null,
      submitted_by: (stored as any).submittedBy ?? null,
      submitted_via: (stored as any).submittedVia ?? null,
      node_count: result?.nodes.length ?? null,
    })
  })

  // ----------------------------------------------------------------
  // GET /v1/tasks/:id/result
  app.get<{ Params: { id: string } }>(
    '/v1/tasks/:id/result',
    { onRequest: [auth, readGate] },
    async (request, reply) => {
      const { id } = request.params
      const result = taskResults.get(id)
      if (!result) {
        reply.status(404).send({
          error: 'No result yet',
          code: 'NOT_READY',
          task_id: id,
        })
        return
      }
      const sorted = [...result.nodes].sort((a, b) => a.nodeId.localeCompare(b.nodeId))
      const combined = sorted.map(n => `=== ${n.nodeId} ===\n${n.result}`).join('\n\n')
      reply.send({
        task_id: id,
        result: combined,
        node_results: sorted.map(n => ({ node_id: n.nodeId, result: n.result })),
      })
    },
  )
}

/**
 * Translate Treasury require() messages into stable codes for SDK error
 * handling. Defensive: unknown reverts fall through as TX_REVERTED so
 * we never lie about why we 4xx'd.
 */
function mapTreasuryRevert(reason: string): string {
  const lower = reason.toLowerCase()
  if (lower.includes('insufficient balance')) return 'INSUFFICIENT_BALANCE'
  if (lower.includes('daily cap')) return 'CAP_EXHAUSTED'
  if (lower.includes('key frozen')) return 'KEY_FROZEN'
  if (lower.includes('key/user mismatch')) return 'KEY_NOT_BOUND'
  if (lower.includes('zero amount')) return 'ZERO_AMOUNT'
  return 'TX_REVERTED'
}
