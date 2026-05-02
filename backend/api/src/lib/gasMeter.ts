import { ethers, type ContractTransactionReceipt, type TransactionReceipt, type TransactionResponse } from 'ethers'
import { getChainClient, USDC_DECIMALS } from '../v1/chain'

/** Both contract calls and raw `sendTransaction` produce receipts — the
 *  meter only reads `gasUsed` + `gasPrice`, which both shapes expose. */
type AnyReceipt = Pick<ContractTransactionReceipt, 'gasUsed' | 'gasPrice'> | Pick<TransactionReceipt, 'gasUsed' | 'gasPrice'>

/**
 * Operator-paid gas accounting. Every on-chain tx the SporeiseRunner
 * fires on behalf of a sporeise'd agent gets metered through here:
 * native 0G gas cost is converted to a USDC-equivalent and debited
 * from the API key owner's Treasury balance.
 *
 * **Why not pre-fund agent wallets directly?** That's how the legacy
 * `AgentManager` works (each agent gets prefunded native OG, then signs
 * its own txs). Sporeise'd agents have no on-chain identity beyond a
 * label — the operator submits everything from a single funding wallet
 * — so post-tx accounting is the natural fit.
 *
 * Pricing model: a configurable USDC-per-OG rate (env
 * `SPOREISE_OG_USDC_RATE`, default 0.5 USDC per 1 OG = 5e5 base units
 * per ether). Real production should plug in a price oracle; the demo
 * uses a static rate so the math stays predictable.
 *
 * Conservation: every successful debit returns the new Treasury balance
 * so the calling Runner can surface it in WS events. Failed debits do
 * NOT roll back the on-chain tx — gas is real and the operator paid
 * for it; we just log loudly and keep going. The user's bill drifts
 * by at most one tx in that case.
 */

// 1 OG = 0.5 USDC (in 6-decimal base units = 500_000). Override per env.
const DEFAULT_RATE_USDC_PER_OG = ethers.parseUnits(
  process.env.SPOREISE_OG_USDC_RATE ?? '0.5',
  USDC_DECIMALS,
)

/** Compute the USDC base-units cost of a confirmed receipt's gas burn.
 *  No Treasury side-effect — caller chains this into `debit()`. */
export function gasCostInUsdcWei(
  receipt: AnyReceipt | null | undefined,
  tx?: Pick<TransactionResponse, 'gasPrice' | 'maxFeePerGas'> | null,
): bigint {
  if (!receipt) return 0n
  // ethers v6 puts effectiveGasPrice on the receipt as `gasPrice`. Some
  // testnet RPCs leave it null; fall back to the tx's posted maxFeePerGas
  // / gasPrice so we don't bill 0.
  const effective = receipt.gasPrice ?? tx?.gasPrice ?? tx?.maxFeePerGas ?? 0n
  const gasWei = receipt.gasUsed * effective
  // gasWei is denominated in OG (1e18). Convert to USDC base units (1e6).
  // usdcCost = gasWei * USDC_PER_OG / 1e18
  return (gasWei * DEFAULT_RATE_USDC_PER_OG) / 10n ** 18n
}

export interface DebitResult {
  /** USDC base units actually debited (== `cost` on success, 0n if the
   *  cost rounded down to zero or the user balance was insufficient). */
  amountWei: bigint
  /** USDC base units that WOULD have been debited had the operator
   *  config been correct. Equals `amountWei` on success; equals the
   *  full cost when soft-failed (operator absorbed it). Surfaced so
   *  the runner can show the user what billing will look like once
   *  the operator config is fixed, even when current debits no-op. */
  shouldHaveDebitedWei: bigint
  /** Treasury balance after the debit, in USDC base units. */
  balanceWei: bigint
  /** True iff the user's balance covered the full cost. When false the
   *  Runner should still let the in-flight task finish (gas already
   *  burned) and surface a `task_failed` immediately after with phase
   *  'billing' so the user can top up. */
  paidInFull: boolean
}

/** Memoize whether the configured operator EOA is actually the
 *  Treasury's `operator()` field. If not, every debit call would revert
 *  with "not operator" — we instead degrade gracefully (log once,
 *  return 0-cost results) so the user's task still completes. The fix
 *  is a separate ops step (`contracts/scripts/rotate-operator.ts`).
 *  Re-checked once per process. */
let operatorMatches: boolean | null = null
let operatorWarned = false

async function ensureOperatorAuthorized(): Promise<boolean> {
  if (operatorMatches !== null) return operatorMatches
  const client = getChainClient()
  if (!client.writeGasTreasury || !client.operatorAddress) {
    operatorMatches = false
    return false
  }
  try {
    // Read operator() on the GAS Treasury (which may be separate from
    // the main Treasury — see chain.ts gasTreasuryAddr). When env points
    // at the dedicated SporeGasTreasury, this call succeeds because
    // that contract was deployed with our PRIVATE_KEY as operator.
    const onChain = (await (client.readGasTreasury as any).operator()) as string
    operatorMatches = onChain.toLowerCase() === client.operatorAddress.toLowerCase()
    if (!operatorMatches && !operatorWarned) {
      operatorWarned = true
      console.warn(
        `[gasMeter] Gas Treasury (${client.gasTreasuryAddr}) operator mismatch — on-chain ${onChain}, configured ${client.operatorAddress}. Sporeise gas debits will be skipped (no-op). Either rotate the operator or set L2_SPORE_GAS_TREASURY_ADDRESS to a Treasury whose operator matches PRIVATE_KEY.`,
      )
    }
  } catch (err) {
    // Treasury contract has no operator() getter at this address, or RPC
    // failed. Treat as "operator unknown" → skip debits, surface no errors.
    operatorMatches = false
    if (!operatorWarned) {
      operatorWarned = true
      console.warn(`[gasMeter] could not read GasTreasury.operator(): ${(err as Error).message}. Gas debits will be skipped.`)
    }
  }
  return operatorMatches
}

/** Debit `userAddress`'s sporeise gas Treasury balance by `costWei` USDC
 *  (6 decimals). Operator-signed `Treasury.debitBalance`. Targets the
 *  sporeise-specific gas Treasury (`L2_SPORE_GAS_TREASURY_ADDRESS`)
 *  when set, falling back to the main SwarmTreasury. Idempotency is
 *  the caller's problem — pass a deterministic tx receipt only once. */
export async function debitTreasury(
  userAddress: string,
  costWei: bigint,
): Promise<DebitResult> {
  const client = getChainClient()
  if (!client.writeGasTreasury) {
    throw new Error('[gasMeter] writeGasTreasury unavailable — operator wallet not configured')
  }
  if (costWei <= 0n) {
    const balanceWei = (await client.readGasTreasury.balanceOf(userAddress)) as bigint
    return { amountWei: 0n, shouldHaveDebitedWei: 0n, balanceWei, paidInFull: true }
  }

  // Soft-fail when the deployed Treasury isn't owned by our operator EOA.
  // Operator-funded model assumption: the operator absorbs gas if billing
  // pipeline is broken; user's task still completes. We still report
  // `shouldHaveDebitedWei` so the runner can surface what billing will
  // look like once the operator config is rotated correctly.
  if (!(await ensureOperatorAuthorized())) {
    const balanceWei = (await client.readGasTreasury.balanceOf(userAddress)) as bigint
    return { amountWei: 0n, shouldHaveDebitedWei: costWei, balanceWei, paidInFull: true }
  }

  const balanceWei = (await client.readGasTreasury.balanceOf(userAddress)) as bigint
  if (balanceWei < costWei) {
    // Don't let the contract revert here — surface the gap to the caller
    // so it can decide whether to debit what's left or fail the task.
    return { amountWei: 0n, shouldHaveDebitedWei: costWei, balanceWei, paidInFull: false }
  }
  try {
    const tx = await client.writeGasTreasury.debitBalance(userAddress, costWei)
    await tx.wait()
  } catch (err) {
    // "not operator" reverts after the cached check should be rare — only
    // if operator was rotated mid-process. Treat the same way: warn and
    // soft-pass so the task isn't bricked.
    const rawMsg = (err as Error).message ?? ''
    const msg = rawMsg.toLowerCase()
    if (msg.includes('not operator')) {
      operatorMatches = false
      if (!operatorWarned) {
        operatorWarned = true
        console.warn('[gasMeter] Treasury debit reverted with "not operator" — disabling further debits this process.')
      }
      const after = (await client.readGasTreasury.balanceOf(userAddress)) as bigint
      return { amountWei: 0n, shouldHaveDebitedWei: costWei, balanceWei: after, paidInFull: true }
    }
    // Surface the actual revert reason — without this the runner sees a
    // generic "Treasury debit failed" with no clue why (RPC blip vs
    // insufficient balance vs gas estimation failure vs nonce race).
    console.warn(
      `[gasMeter] debitBalance threw (cost=${formatUsdc(costWei)} USDC, user=${userAddress.slice(0, 12)}…): ${rawMsg.slice(0, 240)}`,
    )
    // Transient errors (RPC, nonce, gas-est blip) shouldn't kill the
    // user's task when there's plenty of balance. Treat as operator-
    // absorbed: report shouldHaveDebited so audit numbers stay correct,
    // mark paidInFull=true so the runner continues. Only true
    // "insufficient balance" gets a paidInFull=false to surface a
    // genuine top-up prompt.
    const after = (await client.readGasTreasury.balanceOf(userAddress)) as bigint
    if (msg.includes('insufficient balance')) {
      return { amountWei: 0n, shouldHaveDebitedWei: costWei, balanceWei: after, paidInFull: false }
    }
    return { amountWei: 0n, shouldHaveDebitedWei: costWei, balanceWei: after, paidInFull: true }
  }
  const after = (await client.readTreasury.balanceOf(userAddress)) as bigint
  return { amountWei: costWei, shouldHaveDebitedWei: costWei, balanceWei: after, paidInFull: true }
}

/** Convenience: meter + debit a confirmed receipt in one call. Accepts
 *  both `ContractTransactionReceipt` (from contract method calls) and
 *  the plain `TransactionReceipt` (from `Wallet.sendTransaction`). */
export async function meterAndDebit(
  userAddress: string,
  receipt: AnyReceipt | null | undefined,
  tx?: TransactionResponse | null,
): Promise<DebitResult> {
  const cost = gasCostInUsdcWei(receipt, tx)
  return debitTreasury(userAddress, cost)
}

/** Format a USDC base-units amount for the human-readable WS payload. */
export function formatUsdc(wei: bigint): string {
  return ethers.formatUnits(wei, USDC_DECIMALS)
}
