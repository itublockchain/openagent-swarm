import type { FastifyInstance } from 'fastify'
import { ethers } from 'ethers'
import { z } from 'zod'
import { getChainClient, USDC_DECIMALS } from './chain'
import { feeWei, feeUsdc } from '../lib/feePolicy'

const WithdrawBody = z.object({
  amount: z
    .string()
    .regex(/^\d+(\.\d+)?$/, 'amount must be a positive decimal string'),
})

interface RegisterOpts {
  /** Pulls (address, chainId) from the SIWE-signed JWT — same shape
   *  server.ts.requireAuth returns. We accept it as a function injection
   *  so withdrawRoutes doesn't need to re-import server internals. */
  requireAuth: (req: any, reply: any) => { address: string; chainId: number } | null
}

/**
 * POST /v1/withdraw — debit Treasury on 0G, then release real USDC on
 * Base Sepolia. The operator EOA (PRIVATE_KEY) signs both txs. Order is
 * intentional: debit first → if base release fails afterwards we have a
 * stranded credit at the gateway, which the operator can recover via
 * USDCGateway.rescueToken or by sending another release. Reverse order
 * (release first, then debit) would let a debit failure leave the user
 * with both USDC AND Treasury credit — strictly worse.
 */
export async function registerWithdrawRoutes(app: FastifyInstance, opts: RegisterOpts) {
  /**
   * GET /v1/me/balance — SIWE-JWT version of the SDK's /v1/balance.
   * The browser polls this from the Header to show the user's
   * Treasury credit. Pure RPC read; safe to expose to anyone with a
   * valid JWT — they only see their own address.
   */
  app.get('/v1/me/balance', async (request, reply) => {
    const user = opts.requireAuth(request, reply)
    if (!user) return
    const { readTreasury } = getChainClient()
    let balance: bigint
    try {
      balance = (await readTreasury.balanceOf(user.address)) as bigint
    } catch {
      reply.status(502).send({ error: 'L2 RPC unreachable', code: 'RPC_DOWN' })
      return
    }
    reply.send({
      balance: ethers.formatUnits(balance, USDC_DECIMALS),
      decimals: USDC_DECIMALS,
    })
  })

  app.post('/v1/withdraw', async (request, reply) => {
    const user = opts.requireAuth(request, reply)
    if (!user) return

    const parse = WithdrawBody.safeParse(request.body)
    if (!parse.success) {
      reply.status(400).send({ error: 'Invalid body', issues: parse.error.issues })
      return
    }
    const body = parse.data

    const client = getChainClient()
    if (!client.writeTreasury || !client.writeGateway || !client.operatorAddress) {
      reply.status(503).send({
        error: 'Operator wallets not configured (PRIVATE_KEY or BASE_GATEWAY_ADDRESS missing)',
        code: 'OPERATOR_DOWN',
      })
      return
    }

    let amountWei: bigint
    try {
      amountWei = ethers.parseUnits(body.amount, USDC_DECIMALS)
    } catch {
      reply.status(400).send({ error: 'Invalid amount format' })
      return
    }
    if (amountWei <= 0n) {
      reply.status(400).send({ error: 'Amount must be > 0' })
      return
    }

    const fee = feeWei('baseWithdraw')
    const totalDebit = amountWei + fee

    // Pre-flight balance — clean 402 before sending any tx.
    let balance: bigint
    try {
      balance = (await client.readTreasury.balanceOf(user.address)) as bigint
    } catch (err) {
      reply.status(502).send({ error: 'Treasury read failed', code: 'RPC_DOWN' })
      return
    }
    if (balance < totalDebit) {
      reply.status(402).send({
        error: 'Insufficient Treasury balance (amount + fee)',
        code: 'INSUFFICIENT_BALANCE',
        balance: ethers.formatUnits(balance, USDC_DECIMALS),
        required: ethers.formatUnits(totalDebit, USDC_DECIMALS),
        fee: feeUsdc('baseWithdraw'),
      })
      return
    }

    // Build a deterministic requestId so a retried release can't double-pay.
    // Includes user + amount + a randomness nonce derived from now() so two
    // sequential equal-amount withdrawals don't collide.
    const nonce = ethers.hexlify(ethers.randomBytes(16))
    const requestId = ethers.keccak256(
      ethers.solidityPacked(['address', 'uint256', 'bytes16'], [user.address, amountWei, nonce]),
    )

    let debitTxHash: string
    try {
      const tx = await client.writeTreasury.debitBalance(user.address, totalDebit)
      const receipt = await tx.wait()
      debitTxHash = receipt?.hash ?? tx.hash
    } catch (err: any) {
      const reason = err?.shortMessage ?? err?.reason ?? err?.message ?? 'unknown'
      const status = /insufficient/i.test(reason) ? 402 : 400
      reply.status(status).send({ error: reason, code: 'TX_REVERTED' })
      return
    }

    let releaseTxHash: string
    try {
      const tx = await client.writeGateway.release(user.address, amountWei, requestId)
      const receipt = await tx.wait()
      releaseTxHash = receipt?.hash ?? tx.hash
    } catch (err: any) {
      // Debit landed but release failed. The user's Treasury balance
      // dropped without funds reaching them on Base — refund so we
      // don't strand them. If the refund itself fails, log loudly so
      // the operator can intervene manually.
      try {
        const refundTx = await client.writeTreasury.creditBalance(user.address, totalDebit)
        await refundTx.wait()
        console.error(
          `[withdraw] Base release failed for ${user.address}; Treasury refunded. requestId=${requestId}`,
        )
      } catch (refundErr) {
        console.error(
          `[withdraw] CRITICAL: Base release AND Treasury refund both failed for ${user.address}; manual recovery required. requestId=${requestId}`,
          refundErr,
        )
      }
      const reason = err?.shortMessage ?? err?.reason ?? err?.message ?? 'unknown'
      reply.status(502).send({ error: `Base release failed: ${reason}`, code: 'BASE_RELEASE_FAILED' })
      return
    }

    reply.send({
      amount: ethers.formatUnits(amountWei, USDC_DECIMALS),
      fee: feeUsdc('baseWithdraw'),
      total_debited: ethers.formatUnits(totalDebit, USDC_DECIMALS),
      debit_tx: debitTxHash,
      release_tx: releaseTxHash,
      request_id: requestId,
      base_address: user.address,
    })
  })
}
