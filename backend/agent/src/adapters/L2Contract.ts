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
    const formatted = this.formatId(taskId)
    try {
      const tx = await this.registry.claimPlanner(formatted)
      await tx.wait()
    } catch (error) {
      console.log(`[L2Contract] claimPlanner tx failed for ${taskId}:`, error)
      return false
    }
    // The contract returns false silently when the planner slot is already
    // taken (no revert), so a successful tx does NOT imply a successful claim.
    // Read the registry state and compare to our signer to know who actually won.
    try {
      const winner: string = await this.registry.planners(formatted)
      return winner.toLowerCase() === this.signer.address.toLowerCase()
    } catch (error) {
      console.log(`[L2Contract] claimPlanner verify failed for ${taskId}:`, error)
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
    const formatted = this.formatId(nodeId)
    try {
      const tx = await this.registry.claimSubtask(formatted)
      await tx.wait()
    } catch (error) {
      console.log(`[L2Contract] claimSubtask tx failed for ${nodeId}:`, error)
      return false
    }
    // Same lying-true issue as claimPlanner: claimSubtask silently returns
    // false when the slot is already filled. Verify via state read.
    try {
      const node = await this.registry.nodes(formatted)
      return (node.claimedBy as string).toLowerCase() === this.signer.address.toLowerCase()
    } catch (error) {
      console.log(`[L2Contract] claimSubtask verify failed for ${nodeId}:`, error)
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

  async stakeForSubtask(taskId: string, nodeId: string, amount: string): Promise<string> {
    const decimals = await this.getDecimals()
    const stakeAmount = ethers.parseUnits(amount, decimals)
    await this.ensureEscrowAllowance(stakeAmount)
    const tx = await this.escrow.stakeForSubtask(
      this.formatId(taskId),
      this.formatId(nodeId),
      stakeAmount,
    )
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

  async markValidatedBatch(nodeIds: string[]): Promise<void> {
    const formatted = nodeIds.map(id => this.formatId(id))
    const tx = await this.registry.markValidatedBatch(formatted)
    await tx.wait()
    console.log(`[L2Contract] ${nodeIds.length} nodes marked validated in single tx`)
  }

  async getNodeClaimant(nodeId: string): Promise<string> {
    const node = await this.registry.nodes(this.formatId(nodeId))
    return node.claimedBy as string
  }

  async getTaskBudget(taskId: string): Promise<string> {
    const task = await this.escrow.tasks(this.formatId(taskId))
    return task.budget.toString()
  }

  async settleTask(taskId: string, winners: string[], amounts: string[]): Promise<void> {
    const tx = await this.registry.requestSettle(this.formatId(taskId), winners, amounts)
    await tx.wait()
    console.log(`[L2Contract] settleTask: paid ${winners.length} winners for task ${taskId}`)
  }

  async challenge(nodeId: string, challengerNodeId?: string): Promise<void> {
    const formattedNodeId = this.formatId(nodeId)
    // Get the accused agent's address from the registry (the node's claimant)
    const node = await this.registry.nodes(formattedNodeId)
    const accused = node.claimedBy
    if (accused === ethers.ZeroAddress) {
      throw new Error(`[L2Contract] Cannot challenge node ${nodeId}: no claimant found`)
    }
    const challengerSubtask = challengerNodeId
      ? this.formatId(challengerNodeId)
      : ethers.ZeroHash
    const tx = await this.vault.challenge(formattedNodeId, accused, challengerSubtask)
    await tx.wait()
    console.log(`[L2Contract] Challenge raised for node ${nodeId} against ${accused}`)
  }

  async resetSubtask(nodeId: string): Promise<void> {
    // resetNode is invoked by the vault on a successful challenge resolution
    // (jury verdict = guilty). Agent-side this is a no-op, kept for the port
    // contract.
    console.log(`[L2Contract] resetSubtask for ${nodeId} — handled by vault on-chain on guilty verdict`)
  }

  async voteOnChallenge(nodeId: string, agentId: string, accusedGuilty: boolean): Promise<void> {
    const formattedNodeId = this.formatId(nodeId)
    const formattedAgentId = this.formatId(agentId)
    try {
      const tx = await this.vault.vote(formattedNodeId, formattedAgentId, accusedGuilty)
      await tx.wait()
      console.log(
        `[L2Contract] Voted ${accusedGuilty ? 'GUILTY' : 'INNOCENT'} on challenge for node ${nodeId}`,
      )
    } catch (err: any) {
      // The vote can fail benignly if quorum was reached just before our tx
      // landed, the window expired, or another juror's tx tied the slot.
      // Log and swallow so the agent's main loop is not derailed.
      console.warn(`[L2Contract] voteOnChallenge skipped for ${nodeId}: ${err?.shortMessage ?? err?.message ?? err}`)
    }
  }

  async finalizeExpiredChallenge(nodeId: string): Promise<void> {
    try {
      const tx = await this.vault.finalizeExpired(this.formatId(nodeId))
      await tx.wait()
      console.log(`[L2Contract] finalizeExpired closed challenge for node ${nodeId}`)
    } catch (err: any) {
      console.warn(`[L2Contract] finalizeExpiredChallenge skipped for ${nodeId}: ${err?.shortMessage ?? err?.message ?? err}`)
    }
  }

  async completeTask(_taskId: string): Promise<boolean> {
    // No-op on real chain. Settlement is now an explicit two-step:
    //   1) markValidatedBatch(nodeIds) — releases stakes, emits DAGCompleted
    //   2) requestSettle(taskId, winners, amounts) — distributes the budget
    // Both are called directly by validateLastNodeAsPlanner. This method
    // exists only to satisfy IChainPort; returning true keeps the legacy
    // caller path happy without producing on-chain side effects.
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
