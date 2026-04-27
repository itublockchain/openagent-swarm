import { ethers } from 'ethers'
import { IChainPort } from '../../../../shared/ports'
import DAGRegistryABI from '../../../../contracts/artifacts/src/DAGRegistry.sol/DAGRegistry.json'
import SwarmEscrowABI from '../../../../contracts/artifacts/src/SwarmEscrow.sol/SwarmEscrow.json'
import deployments from '../../../../contracts/deployments/og_testnet.json'

export class L2Contract implements IChainPort {
  private provider: ethers.JsonRpcProvider
  private signer: ethers.Wallet
  private registry: ethers.Contract
  private escrow: ethers.Contract

  constructor(private agentId: string) {
    this.provider = new ethers.JsonRpcProvider(process.env.OG_RPC_URL!)
    this.signer = new ethers.Wallet(process.env.PRIVATE_KEY!, this.provider)

    this.registry = new ethers.Contract(
      deployments.DAGRegistry,
      DAGRegistryABI.abi,
      this.signer
    )
    this.escrow = new ethers.Contract(
      deployments.SwarmEscrow,
      SwarmEscrowABI.abi,
      this.signer
    )
  }

  async claimPlanner(taskId: string): Promise<boolean> {
    try {
      // taskId is bytes32, but it might be passed as string. ethers handles string to bytes32 if prefixed with 0x.
      // If it's a plain string, we should hash it or ensure it's 32 bytes.
      const formattedTaskId = taskId.startsWith('0x') ? taskId : ethers.id(taskId)
      const tx = await this.registry.claimPlanner(formattedTaskId)
      await tx.wait()
      return true
    } catch (error) {
      console.log(`[L2Contract] claimPlanner failed for ${taskId}`)
      return false
    }
  }

  async claimSubtask(nodeId: string): Promise<boolean> {
    try {
      const formattedNodeId = nodeId.startsWith('0x') ? nodeId : ethers.id(nodeId)
      const tx = await this.registry.claimSubtask(formattedNodeId)
      await tx.wait()
      return true
    } catch (error) {
      console.log(`[L2Contract] claimSubtask failed for ${nodeId}`)
      return false
    }
  }

  async isSubtaskClaimed(nodeId: string): Promise<boolean> {
    const formattedNodeId = nodeId.startsWith('0x') ? nodeId : ethers.id(nodeId)
    const node = await this.registry.nodes(formattedNodeId)
    return node.claimedBy !== ethers.ZeroAddress
  }

  async stake(taskId: string, amount: string): Promise<string> {
    const formattedTaskId = taskId.startsWith('0x') ? taskId : ethers.id(taskId)
    const tx = await this.escrow.stake(formattedTaskId, ethers.parseEther(amount))
    const receipt = await tx.wait()
    return receipt!.hash
  }

  async challenge(nodeId: string): Promise<void> {
    const formattedNodeId = nodeId.startsWith('0x') ? nodeId : ethers.id(nodeId)
    const tx = await this.registry.challengeNode(formattedNodeId)
    await tx.wait()
  }

  async resetSubtask(nodeId: string): Promise<void> {
    const formattedNodeId = nodeId.startsWith('0x') ? nodeId : ethers.id(nodeId)
    const tx = await this.registry.resetNode(formattedNodeId)
    await tx.wait()
  }

  async completeTask(taskId: string): Promise<boolean> {
    try {
      // In our contract DAGRegistry.sol, there isn't a direct completeTask(taskId).
      // Instead, markValidated on the last node triggers settle in escrow.
      // However, SwarmAgent calls completeTask at the end of claimNextAfter.
      // We might need to implement this in the contract or return true if logic is handled elsewhere.
      console.log(`[L2Contract] completeTask called for ${taskId} (handled by markValidated on-chain)`)
      return true
    } catch {
      return false
    }
  }

  async settle(taskId: string, winners: string[]): Promise<void> {
    const formattedTaskId = taskId.startsWith('0x') ? taskId : ethers.id(taskId)
    const tx = await this.escrow.settle(formattedTaskId, winners)
    await tx.wait()
  }

  // Sync methods are no-ops for real chain
  async syncPlannerClaim(taskId: string, agentId: string): Promise<void> {}
  async syncSubtaskClaim(nodeId: string, agentId: string): Promise<void> {}
  async syncTaskCompletion(taskId: string, agentId: string): Promise<void> {}
}
