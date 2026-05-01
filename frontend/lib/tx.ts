import { waitForTransactionReceipt } from '@wagmi/core'
import { config as wagmiConfig } from './wagmi'

/**
 * Long receipt timeout + slow polling for 0G Galileo. Its
 * `eth_getTransactionReceipt` lags 30-90s behind block inclusion on a
 * regular basis; bumping the wait avoids spurious "could not be found"
 * throws on transactions that actually landed.
 */
export const RECEIPT_OPTS = { timeout: 300_000, pollingInterval: 3_000 } as const

/**
 * Wait for a tx receipt; if the receipt fetch times out, fall back to
 * `verify()` reading chain state directly. Returns once we're confident
 * the tx landed (either via receipt OR via state-verify); throws the
 * underlying receipt error if neither path confirms.
 *
 * Usage:
 *   const hash = await writeContractAsync(...)
 *   await waitTxOrVerify(hash, async () => {
 *     const after = await readContract(wagmiConfig, { ... })
 *     return after === expected
 *   })
 *
 * The verify path is what saves us when the RPC misses the receipt but
 * the tx is actually included — without it, every flaky receipt poll
 * trips a user-visible error even though the chain accepted the tx.
 */
export async function waitTxOrVerify(
  hash: `0x${string}`,
  verify: () => Promise<boolean>,
  opts = RECEIPT_OPTS,
): Promise<void> {
  try {
    await waitForTransactionReceipt(wagmiConfig, { hash, ...opts })
  } catch (err) {
    const landed = await verify().catch(() => false)
    if (!landed) throw err
    // Receipt missed but state confirms — log so it's traceable in devtools
    // without surfacing as a user-facing error.
    console.warn(`[waitTxOrVerify] receipt missed for ${hash} but state verified — continuing`)
  }
}
