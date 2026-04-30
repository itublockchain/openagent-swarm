/**
 * Drain native 0G balance from every agent wallet back to the funding wallet
 * (.env PRIVATE_KEY). Reads encrypted secrets from /data/agent-secrets.json
 * via the same AgentSecretStore the API uses (MASTER_KEY decrypts).
 *
 * Run inside the API container so MASTER_KEY + secrets file are available:
 *
 *   docker cp scripts/drain-agents.cjs swarm-api-1:/tmp/drain-agents.cjs
 *   docker exec swarm-api-1 node /tmp/drain-agents.cjs
 *
 * Optional env overrides:
 *   DRAIN_TO=<0x..>     destination address (default: derived from PRIVATE_KEY)
 *   DRAIN_DRY_RUN=1     print plan, don't send
 *   DRAIN_GAS_RESERVE=0.001  OG kept on each wallet for safety (default 0.0005)
 */

const { ethers } = require('ethers')
const { AgentSecretStore } = require('/app/backend/api/src/AgentSecretStore')

const RPC_URL = process.env.OG_RPC_URL || 'https://evmrpc-testnet.0g.ai'
const FUNDING_PK = process.env.PRIVATE_KEY
const DEST = process.env.DRAIN_TO || (FUNDING_PK ? new ethers.Wallet(FUNDING_PK).address : null)
const DRY_RUN = process.env.DRAIN_DRY_RUN === '1' || process.env.DRAIN_DRY_RUN === 'true'
const GAS_RESERVE_OG = process.env.DRAIN_GAS_RESERVE || '0.0005'

if (!DEST) {
  console.error('[drain] DRAIN_TO not set and PRIVATE_KEY missing — cannot derive destination')
  process.exit(1)
}
if (!ethers.isAddress(DEST)) {
  console.error(`[drain] DRAIN_TO is not a valid address: ${DEST}`)
  process.exit(1)
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { staticNetwork: true })
  const store = new AgentSecretStore()
  const secrets = store.list()

  console.log(`[drain] Destination: ${DEST}`)
  console.log(`[drain] Agents in store: ${secrets.length}`)
  console.log(`[drain] Gas reserve per wallet: ${GAS_RESERVE_OG} OG`)
  console.log(`[drain] Dry run: ${DRY_RUN}`)
  console.log()

  // Snapshot fee data once — saves ~25 RPC calls when we have many agents
  // and the gas-price doesn't move noticeably during a drain pass.
  const feeData = await provider.getFeeData()
  const gasPrice = feeData.gasPrice
    || feeData.maxFeePerGas
    || ethers.parseUnits('1', 'gwei')
  // 21k gas for a plain transfer; doubled buffer absorbs gasPrice volatility.
  const txGasCost = 21000n * gasPrice * 2n
  const reserveWei = ethers.parseEther(GAS_RESERVE_OG)
  const minHeadroom = txGasCost > reserveWei ? txGasCost : reserveWei

  let totalSent = 0n
  let drained = 0
  let skipped = 0
  let failed = 0

  for (const s of secrets) {
    const wallet = new ethers.Wallet(s.privateKey, provider)
    const addr = wallet.address

    let balance
    try {
      balance = await provider.getBalance(addr)
    } catch (err) {
      console.warn(`[drain] ${s.agentId} (${addr}): balance read failed — ${err.message}`)
      failed++
      continue
    }

    const balOG = ethers.formatEther(balance)
    if (balance <= minHeadroom) {
      console.log(`[drain] ${s.agentId} (${addr}): ${balOG} OG ≤ headroom, skip`)
      skipped++
      continue
    }

    const sendAmount = balance - minHeadroom
    const sendOG = ethers.formatEther(sendAmount)

    if (DRY_RUN) {
      console.log(`[drain] ${s.agentId} (${addr}): would send ${sendOG} OG (balance ${balOG})`)
      drained++
      totalSent += sendAmount
      continue
    }

    try {
      const tx = await wallet.sendTransaction({
        to: DEST,
        value: sendAmount,
        gasLimit: 21000n,
      })
      console.log(`[drain] ${s.agentId} (${addr}): sent ${sendOG} OG — tx ${tx.hash}`)
      const receipt = await tx.wait()
      if (receipt && receipt.status === 1) {
        drained++
        totalSent += sendAmount
      } else {
        console.warn(`[drain] ${s.agentId}: tx mined but status != 1`)
        failed++
      }
    } catch (err) {
      console.error(`[drain] ${s.agentId} (${addr}): send failed — ${err.message}`)
      failed++
    }
  }

  console.log()
  console.log(`[drain] Done. drained=${drained} skipped=${skipped} failed=${failed}`)
  console.log(`[drain] Total ${DRY_RUN ? 'planned' : 'sent'}: ${ethers.formatEther(totalSent)} OG`)
}

main().catch(err => {
  console.error('[drain] fatal:', err)
  process.exit(1)
})
