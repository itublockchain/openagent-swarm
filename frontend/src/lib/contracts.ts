/**
 * Minimal ABI fragments for the on-chain pieces the user-side flow touches:
 *   - MockERC20: approve, allowance, decimals, balanceOf
 *   - SporeEscrow: createTask, tasks (read-only)
 *
 * Addresses come from NEXT_PUBLIC_* env vars; they default to nothing so a
 * misconfigured frontend fails loudly rather than silently writing to a
 * wrong contract.
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
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
] as const

export const SPORE_ESCROW_ABI = [
  {
    type: 'function',
    name: 'createTask',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'taskId', type: 'bytes32' },
      { name: 'budget', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'tasks',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'bytes32' }],
    outputs: [
      { name: 'owner', type: 'address' },
      { name: 'budget', type: 'uint256' },
      { name: 'stakedTotal', type: 'uint256' },
      { name: 'finalized', type: 'bool' },
    ],
  },
] as const

export const CONTRACT_ADDRESSES = {
  usdc: process.env.NEXT_PUBLIC_USDC_ADDRESS as `0x${string}` | undefined,
  escrow: process.env.NEXT_PUBLIC_ESCROW_ADDRESS as `0x${string}` | undefined,
}
