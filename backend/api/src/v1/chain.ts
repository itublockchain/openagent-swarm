import { ethers } from 'ethers'
import SwarmTreasuryABI from '../../../../contracts/artifacts/src/SwarmTreasury.sol/SwarmTreasury.json'
import MockERC20ABI from '../../../../contracts/artifacts/src/MockERC20.sol/MockERC20.json'
import deployments from '../../../../contracts/deployments/og_testnet.json'

/**
 * Treasury / on-chain glue used by the SDK route handlers. Kept in a
 * separate module so v1/* routes don't have to wire ethers themselves —
 * each route just imports `getTreasuryClient()` and gets a typed bundle
 * back.
 *
 * Two clients live here:
 *  - readTreasury / readUsdc — public RPC, no signer, used for balance
 *    queries + view calls.
 *  - writeTreasury — signed by the operator EOA (PRIVATE_KEY env). The
 *    only thing we sign for SDK consumers; everything else (createTask,
 *    settlement) flows through Treasury via spendOnBehalfOf.
 */

let cached: TreasuryClient | null = null

export interface TreasuryClient {
  treasuryAddr: string
  usdcAddr: string
  readProvider: ethers.JsonRpcProvider
  readTreasury: ethers.Contract
  readUsdc: ethers.Contract
  /** Null if PRIVATE_KEY isn't set — write paths short-circuit with a
   *  clear 503 response so dev environments without an operator key don't
   *  crash the server. */
  writeTreasury: ethers.Contract | null
  operatorAddress: string | null
}

export function getTreasuryClient(): TreasuryClient {
  if (cached) return cached
  const rpcUrl = process.env.OG_RPC_URL || 'https://evmrpc-testnet.0g.ai'
  const treasuryAddr = process.env.L2_TREASURY_ADDRESS || (deployments as any).SwarmTreasury
  const usdcAddr = process.env.L2_USDC_ADDRESS || (deployments as any).MockUSDC

  if (!treasuryAddr) {
    throw new Error('[v1/chain] SwarmTreasury address missing — deploy treasury first')
  }
  if (!usdcAddr) {
    throw new Error('[v1/chain] USDC address missing')
  }

  const readProvider = new ethers.JsonRpcProvider(rpcUrl)
  const readTreasury = new ethers.Contract(treasuryAddr, SwarmTreasuryABI.abi, readProvider)
  const readUsdc = new ethers.Contract(usdcAddr, MockERC20ABI.abi, readProvider)

  let writeTreasury: ethers.Contract | null = null
  let operatorAddress: string | null = null
  const pk = process.env.PRIVATE_KEY
  if (pk) {
    const wallet = new ethers.Wallet(pk, readProvider)
    operatorAddress = wallet.address
    writeTreasury = new ethers.Contract(treasuryAddr, SwarmTreasuryABI.abi, wallet)
  }

  cached = {
    treasuryAddr,
    usdcAddr,
    readProvider,
    readTreasury,
    readUsdc,
    writeTreasury,
    operatorAddress,
  }
  return cached
}

/** Reset the cached client. Useful for tests or after env var changes. */
export function _resetTreasuryClient(): void {
  cached = null
}
