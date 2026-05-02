import { waitForTransactionReceipt } from '@wagmi/core'
import { config as wagmiConfig } from './wagmi'

/**
 * Force the wallet onto `target` before signing. We call switchChain
 * unconditionally because `useChainId()`/`getAccount().chainId` only
 * track chains in the wagmi config — when the wallet is on an
 * unsupported chain (e.g. 0G Galileo, id 16602), wagmi's view lags
 * behind the wallet's actual provider state and the "are we already
 * here?" check returns a false positive. MetaMask + most injected
 * wallets short-circuit a switch to the current chain, so issuing
 * the request every time is cheap on the happy path and self-healing
 * on the broken one.
 *
 * After switching we poll `eth_chainId` via the raw provider because
 * some wallets resolve `wallet_switchEthereumChain` before the
 * provider's reported chainId actually flips — without this poll,
 * the next `writeContract` races the switch and viem throws
 * ChainMismatchError.
 */
export async function ensureWalletChain(
  target: number,
  switchChainAsync: (args: { chainId: number }) => Promise<unknown>,
): Promise<void> {
  try {
    await switchChainAsync({ chainId: target })
  } catch (err: any) {
    if (err?.code === 4902 || /unrecognized chain/i.test(String(err?.message))) {
      throw new Error(`Chain ${target} is not configured in your wallet — add it and retry.`)
    }
    if (err?.code === 4001 || /reject/i.test(String(err?.message))) {
      throw new Error(`Chain switch was rejected — switch your wallet to chain ${target} and retry.`)
    }
    throw err
  }
  const eth: any = typeof window !== 'undefined' ? (window as any).ethereum : null
  if (!eth?.request) return
  for (let i = 0; i < 30; i++) {
    const hex = (await eth.request({ method: 'eth_chainId' }).catch(() => null)) as string | null
    if (hex && parseInt(hex, 16) === target) return
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(
    `Wallet did not switch to chain ${target} in time. Switch manually and retry.`,
  )
}

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
