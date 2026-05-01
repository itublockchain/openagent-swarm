import type { FastifyInstance } from 'fastify'
import { ethers } from 'ethers'
import { apiKeyAuth } from './apiKeyAuth'
import { getTreasuryClient } from './chain'
import type { KeyStore } from './keystore'

interface RegisterOpts {
  keyStore: KeyStore
}

/**
 * GET /v1/balance — read user's Treasury balance + daily cap state.
 *
 * Reads are pure RPC calls (no signer) so this endpoint stays available
 * even when the operator EOA is rotated / down. Returns decimal strings
 * (not bigint) because JSON doesn't natively support large integers.
 */
export async function registerBalanceRoutes(app: FastifyInstance, opts: RegisterOpts) {
  const auth = apiKeyAuth({ keyStore: opts.keyStore })

  app.get('/v1/balance', { onRequest: auth }, async (request, reply) => {
    const ctx = request.apiKey!
    const { readTreasury, readUsdc } = getTreasuryClient()

    let decimals: number
    try {
      decimals = Number(await readUsdc.decimals())
    } catch (err) {
      reply.status(502).send({ error: 'L2 RPC unreachable', code: 'RPC_DOWN' })
      return
    }

    const fmt = (n: bigint) => ethers.formatUnits(n, decimals)
    const [balance, cap, spentView] = await Promise.all([
      readTreasury.balanceOf(ctx.userAddress) as Promise<bigint>,
      readTreasury.dailyCap(ctx.userAddress) as Promise<bigint>,
      readTreasury.dailySpentView(ctx.userAddress) as Promise<readonly [bigint, bigint]>,
    ])
    const [spent, windowStart] = spentView

    const dailyWindowResetsAt = windowStart === 0n
      ? null
      : new Date((Number(windowStart) + 86_400) * 1000).toISOString()

    reply.send({
      balance: fmt(balance),
      daily_cap: fmt(cap),
      daily_spent: fmt(spent),
      daily_window_resets_at: dailyWindowResetsAt,
      decimals,
    })
  })
}
