import type { FastifyInstance } from 'fastify'
import { ethers } from 'ethers'
import { apiKeyAuth } from './apiKeyAuth'
import { getChainClient, USDC_DECIMALS } from './chain'
import type { KeyStore } from './keystore'

interface RegisterOpts {
  keyStore: KeyStore
}

/**
 * GET /v1/balance — read user's Treasury balance.
 *
 * Pure RPC read — works even when the operator EOA is rotated / down.
 * Returns decimal strings (not bigint) because JSON doesn't natively
 * support large integers. Decimals are fixed at 6 system-wide
 * (matches Circle USDC on Base Sepolia).
 */
export async function registerBalanceRoutes(app: FastifyInstance, opts: RegisterOpts) {
  const auth = apiKeyAuth({ keyStore: opts.keyStore })

  app.get('/v1/balance', { onRequest: auth }, async (request, reply) => {
    const ctx = request.apiKey!
    const { readTreasury } = getChainClient()

    let balance: bigint
    try {
      balance = (await readTreasury.balanceOf(ctx.userAddress)) as bigint
    } catch (err) {
      reply.status(502).send({ error: 'L2 RPC unreachable', code: 'RPC_DOWN' })
      return
    }

    reply.send({
      balance: ethers.formatUnits(balance, USDC_DECIMALS),
      decimals: USDC_DECIMALS,
    })
  })
}
