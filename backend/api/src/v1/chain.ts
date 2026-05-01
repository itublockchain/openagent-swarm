import { ethers } from 'ethers'
import * as fs from 'fs'
import * as path from 'path'
import SwarmTreasuryABI from '../../../../contracts/artifacts/src/SwarmTreasury.sol/SwarmTreasury.json'
import SwarmEscrowABI from '../../../../contracts/artifacts/src/SwarmEscrow.sol/SwarmEscrow.json'
import USDCGatewayABI from '../../../../contracts/artifacts/src/USDCGateway.sol/USDCGateway.json'
import ogDeployments from '../../../../contracts/deployments/og_testnet.json'

/**
 * Two-chain glue. The swarm runs on 0G Galileo (chainId 16602) but
 * users pay in real USDC on Base Sepolia (chainId 84532). The API
 * operator EOA bridges between them: it credits/debits Treasury on
 * 0G, and matches releases on USDCGateway on Base.
 *
 * USDC is fixed at 6 decimals system-wide (matches Circle's testnet
 * USDC). Treasury balances are stored in the same units — no scaling
 * happens between chains.
 */

export const USDC_DECIMALS = 6

let cached: ChainClient | null = null

interface BaseDeployments {
  USDCGateway?: string
  USDC?: string
}

export interface ChainClient {
  // 0G testnet — swarm contracts
  ogProvider: ethers.JsonRpcProvider
  ogWallet: ethers.Wallet | null
  treasuryAddr: string
  escrowAddr: string
  readTreasury: ethers.Contract
  readEscrow: ethers.Contract
  /** Write paths short-circuit with 503 in routes when these are null. */
  writeTreasury: ethers.Contract | null
  writeEscrow: ethers.Contract | null

  // Base Sepolia — payment gateway only
  baseProvider: ethers.JsonRpcProvider
  baseWallet: ethers.Wallet | null
  gatewayAddr: string
  baseUsdcAddr: string
  readGateway: ethers.Contract
  writeGateway: ethers.Contract | null

  /** Operator EOA address — same key on both chains. Null if PRIVATE_KEY
   *  isn't set. */
  operatorAddress: string | null
}

function loadBaseDeployments(): BaseDeployments {
  const p = path.resolve(__dirname, '../../../../contracts/deployments/base_sepolia.json')
  if (!fs.existsSync(p)) return {}
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as BaseDeployments
  } catch {
    return {}
  }
}

export function getChainClient(): ChainClient {
  if (cached) return cached

  // ---- 0G testnet ----
  const ogRpcUrl = process.env.OG_RPC_URL || 'https://evmrpc-testnet.0g.ai'
  const treasuryAddr = process.env.L2_TREASURY_ADDRESS || (ogDeployments as any).SwarmTreasury
  const escrowAddr = process.env.L2_ESCROW_ADDRESS || (ogDeployments as any).SwarmEscrow
  if (!treasuryAddr) throw new Error('[v1/chain] SwarmTreasury address missing — deploy first')
  if (!escrowAddr) throw new Error('[v1/chain] SwarmEscrow address missing — deploy first')

  const ogProvider = new ethers.JsonRpcProvider(ogRpcUrl, undefined, { staticNetwork: true })
  const readTreasury = new ethers.Contract(treasuryAddr, SwarmTreasuryABI.abi, ogProvider)
  const readEscrow = new ethers.Contract(escrowAddr, SwarmEscrowABI.abi, ogProvider)

  // ---- Base Sepolia ----
  const baseRpcUrl = process.env.BASE_RPC_URL || 'https://sepolia.base.org'
  const baseDeployments = loadBaseDeployments()
  const gatewayAddr = process.env.BASE_GATEWAY_ADDRESS || baseDeployments.USDCGateway || ''
  const baseUsdcAddr =
    process.env.BASE_USDC_ADDRESS ||
    baseDeployments.USDC ||
    '0x036CbD53842c5426634e7929541eC2318f3dCF7e' // Circle's canonical Base Sepolia USDC

  const baseProvider = new ethers.JsonRpcProvider(baseRpcUrl, undefined, { staticNetwork: true })
  const readGateway = gatewayAddr
    ? new ethers.Contract(gatewayAddr, USDCGatewayABI.abi, baseProvider)
    : (null as any)

  // ---- Signer (same PK both chains) ----
  let ogWallet: ethers.Wallet | null = null
  let baseWallet: ethers.Wallet | null = null
  let writeTreasury: ethers.Contract | null = null
  let writeEscrow: ethers.Contract | null = null
  let writeGateway: ethers.Contract | null = null
  let operatorAddress: string | null = null

  const pk = process.env.PRIVATE_KEY
  if (pk) {
    ogWallet = new ethers.Wallet(pk, ogProvider)
    baseWallet = new ethers.Wallet(pk, baseProvider)
    operatorAddress = ogWallet.address
    writeTreasury = new ethers.Contract(treasuryAddr, SwarmTreasuryABI.abi, ogWallet)
    writeEscrow = new ethers.Contract(escrowAddr, SwarmEscrowABI.abi, ogWallet)
    if (gatewayAddr) {
      writeGateway = new ethers.Contract(gatewayAddr, USDCGatewayABI.abi, baseWallet)
    }
  }

  cached = {
    ogProvider,
    ogWallet,
    treasuryAddr,
    escrowAddr,
    readTreasury,
    readEscrow,
    writeTreasury,
    writeEscrow,
    baseProvider,
    baseWallet,
    gatewayAddr,
    baseUsdcAddr,
    readGateway,
    writeGateway,
    operatorAddress,
  }
  return cached
}

/** Back-compat alias. */
export const getTreasuryClient = getChainClient

/** Reset cached client. Useful for tests / env reloads. */
export function _resetChainClient(): void {
  cached = null
}
