/**
 * Circle CCTP V2 client config — destination Base Sepolia, source chains
 * Ethereum Sepolia + Arbitrum Sepolia. Mirrors the backend's
 * CCTP_SOURCE_CHAINS table in v1/chain.ts so both sides agree on which
 * chains the FE may offer to the user.
 *
 * Addresses for TokenMessengerV2 / MessageTransmitterV2 / USDC are pinned
 * here. They are uniform across most CCTP V2 testnets (Circle deploys to
 * the same address via CREATE2). If Circle ever splits per-chain, this is
 * the only file to edit FE-side.
 */

import type { Address } from 'viem'

export const BASE_SEPOLIA_DOMAIN = 6
export const BASE_SEPOLIA_CHAIN_ID = 84532

export interface CctpSourceConfig {
  domain: number
  chainId: number
  name: string
  tokenMessengerV2: Address
  usdc: Address
}

// Circle's V2 testnet contracts — uniform addresses across chains.
const TOKEN_MESSENGER_V2: Address = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA'

export const CCTP_SOURCE_CHAINS: Record<number, CctpSourceConfig> = {
  11155111: {
    chainId: 11155111,
    domain: 0,
    name: 'Ethereum Sepolia',
    tokenMessengerV2: TOKEN_MESSENGER_V2,
    usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  },
  421614: {
    chainId: 421614,
    domain: 3,
    name: 'Arbitrum Sepolia',
    tokenMessengerV2: TOKEN_MESSENGER_V2,
    usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
  },
}

export const SUPPORTED_SOURCE_CHAIN_IDS: ReadonlyArray<number> = Object.keys(CCTP_SOURCE_CHAINS).map(Number)

export function isCctpSourceChain(chainId: number | undefined): chainId is number {
  return chainId != null && chainId in CCTP_SOURCE_CHAINS
}

/**
 * V2 fast-path burn entry point. mintRecipient is bytes32 of the
 * destination receiver address. destinationCaller=bytes32(0) is
 * permissionless — anyone (us, the operator) can submit the
 * receiveMessage on Base. minFinalityThreshold=1000 → Fast Transfer
 * (~8–20s). hookData is empty: the CCTPDepositReceiver derives the
 * credit recipient from messageSender (the EOA that signed this burn),
 * so we don't pass any extra data.
 */
export const TOKEN_MESSENGER_V2_ABI = [
  {
    type: 'function',
    name: 'depositForBurnWithHook',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'destinationDomain', type: 'uint32' },
      { name: 'mintRecipient', type: 'bytes32' },
      { name: 'burnToken', type: 'address' },
      { name: 'destinationCaller', type: 'bytes32' },
      { name: 'maxFee', type: 'uint256' },
      { name: 'minFinalityThreshold', type: 'uint32' },
      { name: 'hookData', type: 'bytes' },
    ],
    outputs: [{ name: 'nonce', type: 'uint64' }],
  },
  {
    type: 'function',
    name: 'depositForBurn',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'destinationDomain', type: 'uint32' },
      { name: 'mintRecipient', type: 'bytes32' },
      { name: 'burnToken', type: 'address' },
      { name: 'destinationCaller', type: 'bytes32' },
      { name: 'maxFee', type: 'uint256' },
      { name: 'minFinalityThreshold', type: 'uint32' },
    ],
    outputs: [{ name: 'nonce', type: 'uint64' }],
  },
] as const

export const FINALITY_THRESHOLD_FAST = 1000
export const FINALITY_THRESHOLD_STANDARD = 2000

export function addressToBytes32(addr: Address): `0x${string}` {
  return `0x${'0'.repeat(24)}${addr.slice(2).toLowerCase()}` as `0x${string}`
}

/** Fee cap. We give Circle generous headroom (10 bps) — testnet typical
 *  is ~1 bp. If `feeExecuted > maxFee` the burn reverts on the source
 *  chain before USDC is locked, so erring high is safe (we only pay
 *  what was actually executed). */
export function calcMaxFee(amount: bigint): bigint {
  return amount / BigInt(1000)
}
