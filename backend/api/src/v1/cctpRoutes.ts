import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { CCTPRelayer, type RelayerStage, type PendingMessage } from '../CCTPRelayer'
import { getChainClient, CCTP_SOURCE_CHAINS } from './chain'

const BurnBody = z.object({
  srcChainId: z.number().int().positive(),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'txHash must be 0x + 64 hex chars'),
})

const StatusQuery = z.object({
  srcChainId: z.coerce.number().int().positive(),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
})

interface RegisterOpts {
  requireAuth: (req: any, reply: any) => { address: string; chainId: number } | null
  relayer: CCTPRelayer
}

/**
 * Routes for the Circle CCTP V2 cross-chain deposit flow.
 *
 *  POST /v1/cctp/burn      — FE hands the source-chain burn txHash; backend
 *                            queues for relay (Iris poll → receiveMessage on Base).
 *  GET  /v1/cctp/status    — FE polls for stage transitions + the final
 *                            "credited on 0G" flag derived from BridgeWatcher.
 *  GET  /v1/cctp/chains    — Public bootstrap config: supported source chains
 *                            + their domain IDs. FE consumes this so we don't
 *                            duplicate the domain table in two places.
 */
export async function registerCctpRoutes(app: FastifyInstance, opts: RegisterOpts) {
  app.post('/v1/cctp/burn', async (request, reply) => {
    const user = opts.requireAuth(request, reply)
    if (!user) return

    const parse = BurnBody.safeParse(request.body)
    if (!parse.success) {
      reply.status(400).send({ error: 'Invalid body', issues: parse.error.issues })
      return
    }
    const { srcChainId, txHash } = parse.data
    if (!CCTP_SOURCE_CHAINS[srcChainId]) {
      reply.status(400).send({
        error: `Unsupported source chain ${srcChainId}`,
        supported: Object.keys(CCTP_SOURCE_CHAINS).map(Number),
      })
      return
    }
    try {
      const result = await opts.relayer.enqueueBurn(srcChainId, txHash, user.address)
      reply.send({
        srcChainId,
        txHash,
        stage: result.status,
        messageHash: result.messageHash,
      })
    } catch (err: any) {
      reply.status(500).send({ error: err?.message ?? 'enqueue failed' })
    }
  })

  app.get('/v1/cctp/status', async (request, reply) => {
    const user = opts.requireAuth(request, reply)
    if (!user) return

    const parse = StatusQuery.safeParse(request.query)
    if (!parse.success) {
      reply.status(400).send({ error: 'Invalid query', issues: parse.error.issues })
      return
    }
    const { srcChainId, txHash } = parse.data
    const entry = opts.relayer.getStatus(srcChainId, txHash, user.address)
    if (!entry) {
      reply.status(404).send({ error: 'no such pending burn for this user' })
      return
    }
    reply.send(serialize(entry))
  })

  app.get('/v1/cctp/chains', async (_req, reply) => {
    const client = getChainClient()
    reply.send({
      destinationDomain: 6,
      destinationChainId: 84532,
      cctpReceiver: client.cctpReceiverAddr || null,
      messageTransmitter: client.messageTransmitterAddr || null,
      sources: Object.entries(CCTP_SOURCE_CHAINS).map(([chainIdStr, cfg]) => ({
        chainId: Number(chainIdStr),
        domain: cfg.domain,
        name: cfg.name,
      })),
    })
  })
}

function serialize(entry: PendingMessage): Record<string, unknown> {
  return {
    srcChainId: entry.srcChainId,
    srcDomain: entry.srcDomain,
    txHash: entry.txHash,
    stage: entry.status as RelayerStage,
    messageHash: entry.messageHash,
    baseTxHash: entry.baseTxHash,
    settleTxHash: entry.settleTxHash,
    attempts: entry.attempts,
    error: entry.lastError,
    firstSeenAt: entry.firstSeenAt,
    lastAttemptAt: entry.lastAttemptAt,
  }
}
