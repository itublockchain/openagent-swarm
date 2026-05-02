/**
 * Minimal ABI fragments for the only on-chain pieces the user-side flow
 * touches now:
 *   - ERC20 (real USDC on Base Sepolia): approve, balanceOf, decimals
 *   - USDCGateway (Base Sepolia): deposit
 *
 * Everything else (Treasury, Escrow, AgentRegistry, DAGRegistry,
 * SlashingVault) lives on 0G and is signed by the API operator — the
 * browser never holds those ABIs.
 *
 * Addresses come from NEXT_PUBLIC_* env vars in lib/env.ts.
 */

export const ERC20_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
] as const

export const USDC_GATEWAY_ABI = [
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [],
  },
] as const

import { ENV } from '../../lib/env'

export const CONTRACT_ADDRESSES = {
  usdc: ENV.USDC_ADDRESS,
  gateway: ENV.GATEWAY_ADDRESS,
  cctpReceiver: ENV.CCTP_RECEIVER_ADDRESS,
}
