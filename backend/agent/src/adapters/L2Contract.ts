import { ethers } from 'ethers'
import { IChainPort } from '../../../../shared/ports'
import DAGRegistryABI from '../../../../contracts/artifacts/src/DAGRegistry.sol/DAGRegistry.json'
import SwarmEscrowABI from '../../../../contracts/artifacts/src/SwarmEscrow.sol/SwarmEscrow.json'
import SlashingVaultABI from '../../../../contracts/artifacts/src/SlashingVault.sol/SlashingVault.json'
import MockERC20ABI from '../../../../contracts/artifacts/src/MockERC20.sol/MockERC20.json'
import deployments from '../../../../contracts/deployments/og_testnet.json'

export class L2Contract implements IChainPort {
  private provider: ethers.JsonRpcProvider
  private signer: ethers.Wallet
  private registry: ethers.Contract
  private escrow: ethers.Contract
  private vault: ethers.Contract
  private usdc: ethers.Contract
  private escrowAddr: string
  private usdcDecimals: number | null = null
  private allowanceEnsured = false

  constructor(private agentId: string) {
    if (!process.env.OG_RPC_URL) {
      throw new Error('[L2Contract] OG_RPC_URL env var is required')
    }
    if (!process.env.PRIVATE_KEY) {
      throw new Error('[L2Contract] PRIVATE_KEY env var is required')
    }
    this.provider = new ethers.JsonRpcProvider(process.env.OG_RPC_URL)
    this.signer = new ethers.Wallet(process.env.PRIVATE_KEY, this.provider)

    // Env vars override the bundled deployments JSON, so the same image can
    // target multiple networks (testnet/mainnet/forks) without a rebuild.
    const dagRegistryAddr = process.env.L2_DAG_REGISTRY_ADDRESS || deployments.DAGRegistry
    this.escrowAddr = process.env.L2_ESCROW_ADDRESS || deployments.SwarmEscrow
    const vaultAddr = process.env.L2_SLASHING_VAULT_ADDRESS || deployments.SlashingVault
    const usdcAddr = process.env.L2_USDC_ADDRESS || deployments.MockUSDC

    this.registry = new ethers.Contract(dagRegistryAddr, DAGRegistryABI.abi, this.signer)
    this.escrow = new ethers.Contract(this.escrowAddr, SwarmEscrowABI.abi, this.signer)
    this.vault = new ethers.Contract(vaultAddr, SlashingVaultABI.abi, this.signer)
    this.usdc = new ethers.Contract(usdcAddr, MockERC20ABI.abi, this.signer)

    console.log(
      `[L2Contract] addresses — registry=${dagRegistryAddr} escrow=${this.escrowAddr} vault=${vaultAddr} usdc=${usdcAddr}`,
    )
  }

  private async getDecimals(): Promise<number> {
    if (this.usdcDecimals !== null) return this.usdcDecimals
    this.usdcDecimals = Number(await this.usdc.decimals())
    return this.usdcDecimals
  }

  private async ensureEscrowAllowance(amount: bigint): Promise<void> {
    // One-time MaxUint256 approval per session — escrow can pull funds for
    // every subsequent stake / createTask without another approve tx.
    if (this.allowanceEnsured) return
    const current: bigint = await this.usdc.allowance(this.signer.address, this.escrowAddr)
    if (current < amount) {
      console.log(`[L2Contract] Approving USDC for escrow (current allowance ${current})...`)
      const tx = await this.usdc.approve(this.escrowAddr, ethers.MaxUint256)
      await tx.wait()
    }
    this.allowanceEnsured = true
  }

  private formatId(id: string): string {
    return id.startsWith('0x') ? id : ethers.id(id)
  }

  private normalizeBytes32(hash: string): string {
    // Pass through real bytes32 hex (e.g. 0G merkle roots, keccak digests).
    if (/^0x[0-9a-fA-F]{64}$/.test(hash)) {
      return hash
    }
    // Anything else (mock IDs, arbitrary strings) is hashed deterministically
    // so submitOutput / markValidated / challenge all reference the same value.
    return ethers.keccak256(ethers.toUtf8Bytes(hash))
  }

  async claimPlanner(taskId: string): Promise<boolean> {
    try {
      const tx = await this.registry.claimPlanner(this.formatId(taskId))
      await tx.wait()
      return true
    } catch (error) {
      console.log(`[L2Contract] claimPlanner failed for ${taskId}:`, error)
      return false
    }
  }

  async registerDAG(taskId: string, nodeIds: string[]): Promise<void> {
    const formattedTaskId = this.formatId(taskId)
    const formattedNodeIds = nodeIds.map(id => this.formatId(id))
    const tx = await this.registry.registerDAG(formattedTaskId, formattedNodeIds)
    await tx.wait()
    console.log(`[L2Contract] DAG registered on-chain for task ${taskId} with ${nodeIds.length} nodes`)
  }

  async claimSubtask(nodeId: string): Promise<boolean> {
    try {
      const tx = await this.registry.claimSubtask(this.formatId(nodeId))
      await tx.wait()
      return true
    } catch (error) {
      console.log(`[L2Contract] claimSubtask failed for ${nodeId}:`, error)
      return false
    }
  }

  async isSubtaskClaimed(nodeId: string): Promise<boolean> {
    const node = await this.registry.nodes(this.formatId(nodeId))
    return node.claimedBy !== ethers.ZeroAddress
  }

  async stake(taskId: string, amount: string): Promise<string> {
    const decimals = await this.getDecimals()
    const stakeAmount = ethers.parseUnits(amount, decimals)
    await this.ensureEscrowAllowance(stakeAmount)
    const tx = await this.escrow.stake(this.formatId(taskId), stakeAmount)
    const receipt = await tx.wait()
    return receipt!.hash
  }

  async submitOutput(nodeId: string, outputHash: string): Promise<void> {
    const formattedNodeId = this.formatId(nodeId)
    const formattedHash = this.normalizeBytes32(outputHash)
    const tx = await this.registry.submitOutput(formattedNodeId, formattedHash)
    await tx.wait()
    console.log(`[L2Contract] Output submitted on-chain for node ${nodeId}`)
  }

  async markValidated(nodeId: string): Promise<void> {
    const tx = await this.registry.markValidated(this.formatId(nodeId))
    await tx.wait()
    console.log(`[L2Contract] Node ${nodeId} marked validated on-chain`)
  }

  async challenge(nodeId: string): Promise<void> {
    const formattedNodeId = this.formatId(nodeId)
    // Get the accused agent's address from the registry (the node's claimant)
    const node = await this.registry.nodes(formattedNodeId)
    const accused = node.claimedBy
    if (accused === ethers.ZeroAddress) {
      throw new Error(`[L2Contract] Cannot challenge node ${nodeId}: no claimant found`)
    }
    const tx = await this.vault.challenge(formattedNodeId, accused)
    await tx.wait()
    console.log(`[L2Contract] Challenge raised for node ${nodeId} against ${accused}`)
  }

  async resetSubtask(nodeId: string): Promise<void> {
    // resetNode can only be called by the vault — this is invoked
    // as part of resolveChallenge on-chain. Agent-side we just log.
    console.log(`[L2Contract] resetSubtask for ${nodeId} — handled by vault on-chain via resolveChallenge`)
  }

  async completeTask(taskId: string): Promise<boolean> {
    // markValidated on the last node triggers settle in escrow automatically.
    // This method signals that the agent considers the DAG complete.
    console.log(`[L2Contract] completeTask for ${taskId} — settlement handled by markValidated chain`)
    return true
  }

  async settle(taskId: string, winners: string[]): Promise<void> {
    const tx = await this.escrow.settle(this.formatId(taskId), winners)
    await tx.wait()
  }

  // Sync methods are no-ops for real chain (on-chain state is authoritative)
  async syncPlannerClaim(_taskId: string, _agentId: string): Promise<void> {}
  async syncSubtaskClaim(_nodeId: string, _agentId: string): Promise<void> {}
  async syncTaskCompletion(_taskId: string, _agentId: string): Promise<void> {}
}
