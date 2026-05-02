import type { FastifyInstance } from 'fastify'
import { ethers } from 'ethers'
import { z } from 'zod'

import { apiKeyAuth, requireScope } from './apiKeyAuth'
import type { KeyStore } from './keystore'
import type { IStoragePort } from '../../../../shared/ports'
import SporeCoordinatorABI from '../../../../contracts/artifacts/src/SporeCoordinator.sol/SporeCoordinator.json'
import SwarmTreasuryABI from '../../../../contracts/artifacts/src/SwarmTreasury.sol/SwarmTreasury.json'
import deployments from '../../../../contracts/deployments/og_testnet.json'

/**
 * `/v1/swarm/*` — relay endpoints for the SDK's managed `Spore` class.
 *
 * Two things this layer does that the SDK can't:
 *   1. Upload every DAG payload + every node's raw output to 0G Storage
 *      and use the returned root hash as the on-chain commitment. The
 *      service is the storage uploader so the dev never holds 0G
 *      credentials.
 *   2. Bill gas back to the dev's pre-funded SwarmTreasury balance via
 *      `Treasury.deductGas` — flat fee per swarm tx for now (Phase 3
 *      can switch to actual gas-cost accounting).
 *
 * SDK never holds an operator key — that's the whole point of this
 * layer. Validator EOAs live INSIDE the SDK so verdict signatures
 * remain tamper-proof relative to the service operator.
 */

const RegisterAgentsBody = z.object({
  agents: z
    .array(
      z.object({
        id: z.string().trim().min(1),
        walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      }),
    )
    .min(1),
})

const SubmitTaskBody = z.object({
  taskIdBytes32: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  specHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  plannerId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  participantIds: z.array(z.string().regex(/^0x[0-9a-fA-F]{64}$/)).min(2),
})

const RegisterDAGBody = z.object({
  taskIdBytes32: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  /** Raw DAG payload — service uploads to 0G Storage. */
  subtasks: z
    .array(
      z.object({
        id: z.string().trim().min(1),
        spec: z.string().trim().min(1),
        deps: z.array(z.string()).optional(),
      }),
    )
    .min(1),
})

const SubmitNodeOutputBody = z.object({
  taskIdBytes32: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  nodeIndex: z.number().int().nonnegative(),
  workerId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  /** Raw output text. Service uploads to 0G Storage. */
  output: z.string(),
})

const SubmitValidationsBody = z.object({
  taskIdBytes32: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  nodeIndex: z.number().int().nonnegative(),
  votes: z
    .array(
      z.object({
        agentId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
        valid: z.boolean(),
        signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
      }),
    )
    .min(1),
})

const CompleteTaskBody = z.object({
  taskIdBytes32: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
})

interface RegisterOpts {
  keyStore: KeyStore
  /** Same storage port the rest of the API uses — MockStorage in dev,
   *  ZeroGStorage in prod. Every DAG / node-output payload goes
   *  through here. */
  storage: IStoragePort
}

/** Flat per-call gas fee. Decimal USDC; 0.01 USDC per swarm tx is the
 *  Phase 2 sticker price. Adjustable via `SWARM_GAS_FEE_USDC` env. */
const DEFAULT_GAS_FEE_USDC = '0.01'

export async function registerSwarmRoutes(app: FastifyInstance, opts: RegisterOpts) {
  const { keyStore, storage } = opts
  const auth = apiKeyAuth({ keyStore })
  const writeGate = requireScope('swarm:write')

  // ─── Operator + contracts ──────────────────────────────────────────
  const rpcUrl = process.env.OG_RPC_URL || 'https://evmrpc-testnet.0g.ai'
  const operatorPk = process.env.PRIVATE_KEY
  const coordinatorAddr =
    process.env.L2_SPORE_COORDINATOR_ADDRESS ||
    (deployments as Record<string, string>).SporeCoordinator
  // Distinct from the legacy L2_TREASURY_ADDRESS — the original
  // SwarmTreasury is wired to SwarmEscrow.setTreasury (one-shot, locked)
  // and used by the /v1/tasks budget path. The SDK swarm pathway gets
  // its own Treasury (deductGas-only, no Escrow dependency) so a redeploy
  // here doesn't disturb the legacy flow.
  const treasuryAddr =
    process.env.L2_SPORE_GAS_TREASURY_ADDRESS ||
    (deployments as Record<string, string>).SporeGasTreasury
  if (!operatorPk) {
    console.warn('[swarmRoutes] PRIVATE_KEY missing — /v1/swarm/* disabled')
    return
  }
  if (!coordinatorAddr || coordinatorAddr === ethers.ZeroAddress) {
    console.warn('[swarmRoutes] SporeCoordinator address missing — /v1/swarm/* disabled')
    return
  }
  const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true })
  const operator = new ethers.Wallet(operatorPk, provider)
  const coordinator = new ethers.Contract(coordinatorAddr, SporeCoordinatorABI.abi, operator)
  const treasury =
    treasuryAddr && treasuryAddr !== ethers.ZeroAddress
      ? new ethers.Contract(treasuryAddr, SwarmTreasuryABI.abi, operator)
      : null
  if (!treasury) {
    console.warn('[swarmRoutes] SwarmTreasury address missing — gas billing disabled (relay still works)')
  }
  console.log(
    `[swarmRoutes] mounted; coordinator=${coordinatorAddr} operator=${operator.address} ` +
      `treasury=${treasuryAddr ?? '<disabled>'}`,
  )

  // Per-tx mutex — ethers v6 NonceManager has a known race when
  // sequential sendTransaction calls overlap.
  let txMutex: Promise<void> = Promise.resolve()
  const sendTx = async <T>(fn: () => Promise<T>): Promise<T> => {
    await txMutex
    let release!: () => void
    txMutex = new Promise<void>((r) => {
      release = r
    })
    try {
      return await fn()
    } finally {
      release()
    }
  }

  // ─── Gas billing helper ───────────────────────────────────────────
  // Pulls the flat fee from the user's Treasury balance into the
  // operator wallet. No-op when treasury isn't configured. Returns
  // false on insufficient balance so the caller can short-circuit
  // with a 402.
  const FEE_DECIMALS = 18
  const gasFeeWei = ethers.parseUnits(
    process.env.SWARM_GAS_FEE_USDC ?? DEFAULT_GAS_FEE_USDC,
    FEE_DECIMALS,
  )
  const billGas = async (
    userAddress: string,
    keyHash: `0x${string}`,
    reply: any,
  ): Promise<boolean> => {
    if (!treasury) return true  // billing disabled
    try {
      const tx = await sendTx(async () => {
        const t = await treasury.deductGas(userAddress, gasFeeWei, keyHash)
        return t.wait()
      })
      return Boolean(tx)
    } catch (err) {
      const e = err as { shortMessage?: string; reason?: string; message?: string }
      const reason = e.shortMessage ?? e.reason ?? e.message ?? 'unknown'
      const lower = reason.toLowerCase()
      if (lower.includes('insufficient balance')) {
        reply.status(402).send({
          error: 'Insufficient Treasury balance for swarm gas fee',
          code: 'INSUFFICIENT_GAS_BALANCE',
          required: ethers.formatUnits(gasFeeWei, FEE_DECIMALS),
        })
        return false
      }
      if (lower.includes('key frozen')) {
        reply.status(403).send({ error: 'Key frozen', code: 'KEY_FROZEN' })
        return false
      }
      reply.status(500).send({ error: `gas billing failed: ${reason}`, code: 'BILLING_ERROR' })
      return false
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────
  const mapRevert = (reason: string): string => {
    const r = reason.toLowerCase()
    if (r.includes('agent inactive')) return 'AGENT_INACTIVE'
    if (r.includes('not participant')) return 'NOT_PARTICIPANT'
    if (r.includes('exists')) return 'TASK_EXISTS'
    if (r.includes('unknown task')) return 'TASK_UNKNOWN'
    if (r.includes('bad state')) return 'BAD_STATE'
    if (r.includes('not operator')) return 'NOT_OPERATOR'
    if (r.includes('node not accepted')) return 'NODE_NOT_ACCEPTED'
    return 'TX_REVERTED'
  }
  const submitOrFail = async (reply: any, fn: () => Promise<{ hash: string }>) => {
    try {
      const receipt = await sendTx(fn)
      return { txHash: receipt.hash }
    } catch (err: unknown) {
      const e = err as { shortMessage?: string; reason?: string; message?: string }
      const reason = e.shortMessage ?? e.reason ?? e.message ?? 'unknown'
      reply.status(400).send({ error: reason, code: mapRevert(reason) })
      return null
    }
  }

  /** Convert a 0G Storage hash into the bytes32 the contract expects.
   *  ZeroGStorage returns 0x-prefixed 32-byte hex roots; MockStorage
   *  returns content-addressed strings. Normalise so chain calls always
   *  see a clean bytes32. */
  const toBytes32 = (hash: string): string => {
    if (/^0x[0-9a-fA-F]{64}$/.test(hash)) return hash
    return ethers.keccak256(ethers.toUtf8Bytes(hash))
  }

  // ─── POST /v1/swarm/register-agents ────────────────────────────────
  app.post('/v1/swarm/register-agents', { onRequest: [auth, writeGate] }, async (req, reply) => {
    const ctx = req.apiKey!
    const parse = RegisterAgentsBody.safeParse(req.body)
    if (!parse.success) {
      reply.status(400).send({ error: 'Invalid body', issues: parse.error.issues })
      return
    }
    if (!(await billGas(ctx.userAddress, ctx.chainKeyHash, reply))) return

    const registered: string[] = []
    for (const a of parse.data.agents) {
      try {
        const r = await sendTx(async () => {
          const tx = await coordinator.registerAgent(ethers.id(a.id), a.walletAddress)
          return tx.wait()
        })
        if (r) registered.push(a.id)
      } catch (err) {
        console.warn(`[swarmRoutes] registerAgent failed for ${a.id}:`, err)
      }
    }
    return { registered }
  })

  // ─── POST /v1/swarm/submit-task ────────────────────────────────────
  app.post('/v1/swarm/submit-task', { onRequest: [auth, writeGate] }, async (req, reply) => {
    const ctx = req.apiKey!
    const parse = SubmitTaskBody.safeParse(req.body)
    if (!parse.success) {
      reply.status(400).send({ error: 'Invalid body', issues: parse.error.issues })
      return
    }
    if (!(await billGas(ctx.userAddress, ctx.chainKeyHash, reply))) return

    const b = parse.data
    const out = await submitOrFail(reply, async () => {
      const tx = await coordinator.submitTask(b.taskIdBytes32, b.specHash, b.plannerId, b.participantIds)
      return tx.wait()
    })
    if (out) return out
  })

  // ─── POST /v1/swarm/register-dag ───────────────────────────────────
  // Uploads the raw subtasks payload to 0G Storage; the returned root
  // hash is what lands on-chain as `dagHash`. SDK gets the same hash
  // back so consumers can audit-fetch the DAG payload by hash later.
  app.post('/v1/swarm/register-dag', { onRequest: [auth, writeGate] }, async (req, reply) => {
    const ctx = req.apiKey!
    const parse = RegisterDAGBody.safeParse(req.body)
    if (!parse.success) {
      reply.status(400).send({ error: 'Invalid body', issues: parse.error.issues })
      return
    }
    if (!(await billGas(ctx.userAddress, ctx.chainKeyHash, reply))) return

    const b = parse.data
    let dagHashRaw: string
    try {
      dagHashRaw = await storage.append({
        kind: 'dag',
        taskIdBytes32: b.taskIdBytes32,
        subtasks: b.subtasks,
        ts: Date.now(),
      })
    } catch (err) {
      reply.status(502).send({
        error: `0G Storage upload failed: ${(err as Error).message}`,
        code: 'STORAGE_ERROR',
      })
      return
    }
    const dagHash = toBytes32(dagHashRaw)

    const out = await submitOrFail(reply, async () => {
      const tx = await coordinator.registerDAG(b.taskIdBytes32, dagHash, b.subtasks.length)
      return tx.wait()
    })
    if (out) return { ...out, dagHash }
  })

  // ─── POST /v1/swarm/submit-node-output ─────────────────────────────
  // Upload the worker's full output to 0G Storage and use the returned
  // root hash as the on-chain commitment. Returning the same hash to
  // the SDK so the validators sign over the canonical, storage-bound
  // value — re-hashing locally would diverge from on-chain truth.
  app.post('/v1/swarm/submit-node-output', { onRequest: [auth, writeGate] }, async (req, reply) => {
    const ctx = req.apiKey!
    const parse = SubmitNodeOutputBody.safeParse(req.body)
    if (!parse.success) {
      reply.status(400).send({ error: 'Invalid body', issues: parse.error.issues })
      return
    }
    if (!(await billGas(ctx.userAddress, ctx.chainKeyHash, reply))) return

    const b = parse.data
    let outputHashRaw: string
    try {
      outputHashRaw = await storage.append({
        kind: 'node_output',
        taskIdBytes32: b.taskIdBytes32,
        nodeIndex: b.nodeIndex,
        workerId: b.workerId,
        output: b.output,
        ts: Date.now(),
      })
    } catch (err) {
      reply.status(502).send({
        error: `0G Storage upload failed: ${(err as Error).message}`,
        code: 'STORAGE_ERROR',
      })
      return
    }
    const outputHash = toBytes32(outputHashRaw)

    const out = await submitOrFail(reply, async () => {
      const tx = await coordinator.submitNodeOutput(b.taskIdBytes32, b.nodeIndex, b.workerId, outputHash)
      return tx.wait()
    })
    if (out) return { ...out, outputHash }
  })

  // ─── POST /v1/swarm/submit-validations ─────────────────────────────
  app.post('/v1/swarm/submit-validations', { onRequest: [auth, writeGate] }, async (req, reply) => {
    const ctx = req.apiKey!
    const parse = SubmitValidationsBody.safeParse(req.body)
    if (!parse.success) {
      reply.status(400).send({ error: 'Invalid body', issues: parse.error.issues })
      return
    }
    if (!(await billGas(ctx.userAddress, ctx.chainKeyHash, reply))) return

    const b = parse.data
    const out = await submitOrFail(reply, async () => {
      const tx = await coordinator.submitValidations(b.taskIdBytes32, b.nodeIndex, b.votes)
      return tx.wait()
    })
    if (out) return out
  })

  // ─── POST /v1/swarm/complete-task ──────────────────────────────────
  app.post('/v1/swarm/complete-task', { onRequest: [auth, writeGate] }, async (req, reply) => {
    const ctx = req.apiKey!
    const parse = CompleteTaskBody.safeParse(req.body)
    if (!parse.success) {
      reply.status(400).send({ error: 'Invalid body', issues: parse.error.issues })
      return
    }
    if (!(await billGas(ctx.userAddress, ctx.chainKeyHash, reply))) return

    const b = parse.data
    const out = await submitOrFail(reply, async () => {
      const tx = await coordinator.completeTask(b.taskIdBytes32)
      return tx.wait()
    })
    if (out) return out
  })
}
