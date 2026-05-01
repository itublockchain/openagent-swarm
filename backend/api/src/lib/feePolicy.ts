import { ethers } from 'ethers'

/**
 * Flat fee table — additional USDC the operator debits from the user's
 * Treasury balance for every backend-relayed action. Covers the operator
 * EOA's 0G gas burn (the operator pays 0G; the user pays USDC).
 *
 * Numbers are quoted in USDC (6 decimals) and converted to wei lazily.
 * Tune by editing the strings — production should swap this for a
 * runtime estimate (gasUsed * gasPrice * 0.57 USDC/0G) but flat fees
 * are predictable and let the SDK quote a clean total upfront.
 */
const FEE_USDC = {
  submitTask: '0.05',
  deployAgent: '0.10',
  agentDeposit: '0.05',
  agentWithdraw: '0.05',
  baseWithdraw: '0.20', // covers Base ETH gas for the gateway release tx
} as const

export type FeeKind = keyof typeof FEE_USDC

const USDC_DECIMALS = 6

export function feeWei(kind: FeeKind): bigint {
  return ethers.parseUnits(FEE_USDC[kind], USDC_DECIMALS)
}

export function feeUsdc(kind: FeeKind): string {
  return FEE_USDC[kind]
}
