import { ethers } from 'ethers'
import { IChainPort } from '../../../../shared/ports'
import DAGRegistryABI from '../../../../contracts/artifacts/src/DAGRegistry.sol/DAGRegistry.json'
import SwarmEscrowABI from '../../../../contracts/artifacts/src/SwarmEscrow.sol/SwarmEscrow.json'
import SlashingVaultABI from '../../../../contracts/artifacts/src/SlashingVault.sol/SlashingVault.json'
import MockERC20ABI from '../../../../contracts/artifacts/src/MockERC20.sol/MockERC20.json'
import deployments from '../../../../contracts/deployments/og_testnet.json'

export class L2Contract implements IChainPort {
  private provider: ethers.JsonRpcProvider
  private wallet: ethers.Wallet
  private registry: ethers.Contract
  private escrow: ethers.Contract
  private vault: ethers.Contract
  private usdc: ethers.Contract
  private escrowAddr: string
  private usdcDecimals: number | null = null
  private allowanceEnsured = false
  private txMutex: Promise<void> = Promise.resolve()

  constructor(private agentId: string) {
    if (!process.env.OG_RPC_URL) {
      throw new Error('[L2Contract] OG_RPC_URL env var is required')
    }
    if (!process.env.PRIVATE_KEY) {
      throw new Error('[L2Contract] PRIVATE_KEY env var is required')
    }
    // staticNetwork stops ethers from auto-firing eth_chainId before every
    // tx (was contributing ~30-40% of our RPC volume into the shared 50 RPS
    // testnet cap and triggering -32005 storms). Chain ID is constant per
    // deployment, no need to keep asking.
    this.provider = new ethers.JsonRpcProvider(
      process.env.OG_RPC_URL,
      undefined,
      { staticNetwork: true },
    )
    this.wallet = new ethers.Wallet(process.env.PRIVATE_KEY, this.provider)

    const dagRegistryAddr = process.env.L2_DAG_REGISTRY_ADDRESS || deployments.DAGRegistry
    this.escrowAddr = process.env.L2_ESCROW_ADDRESS || deployments.SwarmEscrow
    const vaultAddr = process.env.L2_SLASHING_VAULT_ADDRESS || deployments.SlashingVault
    const usdcAddr = process.env.L2_USDC_ADDRESS || deployments.MockUSDC

    this.registry = new ethers.Contract(dagRegistryAddr, DAGRegistryABI.abi, this.wallet)
    this.escrow = new ethers.Contract(this.escrowAddr, SwarmEscrowABI.abi, this.wallet)
    this.vault = new ethers.Contract(vaultAddr, SlashingVaultABI.abi, this.wallet)
    this.usdc = new ethers.Contract(usdcAddr, MockERC20ABI.abi, this.wallet)

    console.log(
      `[L2Contract] addresses — registry=${dagRegistryAddr} escrow=${this.escrowAddr} vault=${vaultAddr} usdc=${usdcAddr}`,
    )
  }

  private async freshNonce(): Promise<number> {
    return this.callWithRetry(() =>
      this.provider.getTransactionCount(this.wallet.address, 'pending'),
    )
  }

  /**
   * Retry wrapper for read-only RPC calls. Without this, a transient -32005
   * (rate exceeded) from the shared 0G testnet RPC propagates as an
   * unhandled rejection and kills the agent process. tx-side retries are
   * handled separately in sendTxWithRetry; this is the read-side twin.
   */
  private async callWithRetry<T>(fn: () => Promise<T>, maxAttempts = 6): Promise<T> {
    let lastErr: any
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await fn()
      } catch (err: any) {
        lastErr = err
        const msg = (err?.message || '').toLowerCase()
        const innerCode = err?.error?.code ?? err?.info?.error?.code
        const isRetryable =
          msg.includes('rate exceeded') ||
          msg.includes('too many') ||
          msg.includes('coalesce error') ||
          msg.includes('timeout') ||
          msg.includes('network') ||
          err?.code === 'UNKNOWN_ERROR' ||
          err?.code === 'TIMEOUT' ||
          err?.code === 'NETWORK_ERROR' ||
          innerCode === -32005 ||
          innerCode === -32603
        if (!isRetryable) throw err
        // Exponential backoff with jitter, capped at ~3.2s.
        const wait = Math.min(200 * 2 ** attempt, 3200) + Math.random() * 200
        await new Promise(r => setTimeout(r, wait))
      }
    }
    throw lastErr
  }

  private async sendTxWithRetry(contract: ethers.Contract, method: string, args: any[], retryCount = 0): Promise<any> {
    await this.txMutex;
    let resolveMutex: () => void;
    this.txMutex = new Promise((resolve) => { resolveMutex = resolve; });

    try {
      const nonce = await this.freshNonce()
      const feeData = await this.provider.getFeeData()

      const bumpPercent = retryCount > 0 ? 150n : 120n
      const overrides: any = { nonce }
      if (feeData.maxFeePerGas) {
        overrides.maxFeePerGas = (feeData.maxFeePerGas * bumpPercent) / 100n
      }
      if (feeData.maxPriorityFeePerGas) {
        overrides.maxPriorityFeePerGas = (feeData.maxPriorityFeePerGas * bumpPercent) / 100n
      }

      const tx = await contract[method](...args, overrides)
      const receipt = await tx.wait()
      resolveMutex!();
      return receipt;
    } catch (err: any) {
      resolveMutex!();
      const msg = (err?.message || '').toLowerCase()
      const innerCode = err?.error?.code ?? err?.info?.error?.code
      // -32005 (rate exceeded) and -32603 (internal) are nested by the
      // testnet RPC; surface them so the retry triggers consistently.
      const isRetryable = msg.includes('replacement underpriced') ||
        msg.includes('nonce too low') ||
        msg.includes('fee too low') ||
        msg.includes('already been used') ||
        msg.includes('rate exceeded') ||
        msg.includes('too many') ||
        msg.includes('coalesce error') ||
        msg.includes('timeout') ||
        err.code === 'REPLACEMENT_UNDERPRICED' ||
        err.code === 'NONCE_EXPIRED' ||
        err.code === 'UNKNOWN_ERROR' ||
        err.code === 'TIMEOUT' ||
        err.code === 'NETWORK_ERROR' ||
        innerCode === -32005 ||
        innerCode === -32603

      if (isRetryable && retryCount < 10) {
        // Exponential backoff is kinder to a hot, throttled RPC than the
        // old fixed delay — many agents retry simultaneously and a flat
        // 1s window pushed them straight back into the rate cap.
        const isRate = msg.includes('rate exceeded') || msg.includes('too many') || innerCode === -32005
        const baseline = isRate ? 800 : 1500
        const delay = Math.min(baseline * Math.pow(1.5, retryCount), 6000) + Math.random() * 300
        console.log(`[L2Contract] Transient error for ${method} (retry ${retryCount + 1}). Waiting ${Math.round(delay)}ms...`)
        await new Promise(r => setTimeout(r, delay))
        return this.sendTxWithRetry(contract, method, args, retryCount + 1)
      }
      throw err
    }
  }

  private async getDecimals(): Promise<number> {
    if (this.usdcDecimals !== null) return this.usdcDecimals
    this.usdcDecimals = Number(await this.callWithRetry(() => this.usdc.decimals()))
    return this.usdcDecimals
  }

  private async ensureEscrowAllowance(amount: bigint): Promise<void> {
    if (this.allowanceEnsured) return
    const current: bigint = await this.callWithRetry(() =>
      this.usdc.allowance(this.wallet.address, this.escrowAddr),
    )
    if (current < amount) {
      console.log(`[L2Contract] Approving USDC for escrow...`)
      await this.sendTxWithRetry(this.usdc, 'approve', [this.escrowAddr, ethers.MaxUint256])
    }
    this.allowanceEnsured = true
  }

  private formatId(id: string): string {
    return id.startsWith('0x') ? id : ethers.id(id)
  }

  private normalizeBytes32(hash: string): string {
    if (/^0x[0-9a-fA-F]{64}$/.test(hash)) return hash
    return ethers.keccak256(ethers.toUtf8Bytes(hash))
  }

  async claimPlanner(taskId: string): Promise<boolean> {
    const formatted = this.formatId(taskId)
    try {
      await this.sendTxWithRetry(this.registry, 'claimPlanner', [formatted])
    } catch (error) {
      console.log(`[L2Contract] claimPlanner tx failed for ${taskId}:`, error)
      return false
    }
    const winner: string = await this.callWithRetry(() => this.registry.planners(formatted))
    return winner.toLowerCase() === this.wallet.address.toLowerCase()
  }

  async registerDAG(taskId: string, nodeIds: string[]): Promise<void> {
    const formattedTaskId = this.formatId(taskId)
    const formattedNodeIds = nodeIds.map(id => this.formatId(id))
    await this.sendTxWithRetry(this.registry, 'registerDAG', [formattedTaskId, formattedNodeIds])
  }

  async claimSubtask(nodeId: string): Promise<boolean> {
    const formatted = this.formatId(nodeId)
    try {
      await this.sendTxWithRetry(this.registry, 'claimSubtask', [formatted])
    } catch (error) {
      console.log(`[L2Contract] claimSubtask tx failed for ${nodeId}:`, error)
      return false
    }
    const node = await this.callWithRetry(() => this.registry.nodes(formatted))
    return (node.claimedBy as string).toLowerCase() === this.wallet.address.toLowerCase()
  }

  async isSubtaskClaimed(nodeId: string): Promise<boolean> {
    const node = await this.callWithRetry(() => this.registry.nodes(this.formatId(nodeId)))
    return node.claimedBy !== ethers.ZeroAddress
  }

  async stake(taskId: string, amount: string): Promise<string> {
    const decimals = await this.getDecimals()
    const stakeAmount = ethers.parseUnits(amount, decimals)
    await this.ensureEscrowAllowance(stakeAmount)
    const receipt = await this.sendTxWithRetry(this.escrow, 'stake', [this.formatId(taskId), stakeAmount])
    return receipt.hash
  }

  async stakeForSubtask(taskId: string, nodeId: string, amount: string): Promise<string> {
    const decimals = await this.getDecimals()
    const stakeAmount = ethers.parseUnits(amount, decimals)
    await this.ensureEscrowAllowance(stakeAmount)
    const receipt = await this.sendTxWithRetry(this.escrow, 'stakeForSubtask', [
      this.formatId(taskId),
      this.formatId(nodeId),
      stakeAmount,
    ])
    return receipt.hash
  }

  async submitOutput(nodeId: string, outputHash: string): Promise<void> {
    const formattedNodeId = this.formatId(nodeId)
    const formattedHash = this.normalizeBytes32(outputHash)
    await this.sendTxWithRetry(this.registry, 'submitOutput', [formattedNodeId, formattedHash])
  }

  async markValidatedBatch(nodeIds: string[]): Promise<void> {
    const formatted = nodeIds.map(id => this.formatId(id))
    await this.sendTxWithRetry(this.registry, 'markValidatedBatch', [formatted])
  }

  // New method: Physical payout of subtask stakes back to workers
  async releaseSubtaskStake(taskId: string, nodeId: string): Promise<void> {
    await this.sendTxWithRetry(this.escrow, 'releaseSubtaskStake', [this.formatId(taskId), this.formatId(nodeId)])
  }

  async getNodeClaimant(nodeId: string): Promise<string> {
    const node = await this.callWithRetry(() => this.registry.nodes(this.formatId(nodeId)))
    return node.claimedBy as string
  }

  async getTaskBudget(taskId: string): Promise<string> {
    const task = await this.callWithRetry(() => this.escrow.tasks(this.formatId(taskId)))
    return task.budget.toString()
  }

  /**
   * How many `stakeAmount`-sized stakes the agent's USDC balance can cover.
   * Returns 0 on read failure (rate-limit retried inside callWithRetry, but
   * a final failure must not let the caller assume infinite balance —
   * fail-closed and let the agent skip claiming this round).
   */
  async getStakeCapacity(stakeAmount: string): Promise<number> {
    try {
      const decimals = await this.getDecimals()
      const stakeWei = ethers.parseUnits(stakeAmount, decimals)
      if (stakeWei === 0n) return Number.MAX_SAFE_INTEGER
      const balance: bigint = await this.callWithRetry(() => this.usdc.balanceOf(this.wallet.address))
      return Number(balance / stakeWei)
    } catch (err) {
      console.warn(`[L2Contract] getStakeCapacity failed:`, err)
      return 0
    }
  }

  async getOwnUsdcBalance(): Promise<string> {
    const balance: bigint = await this.callWithRetry(() =>
      this.usdc.balanceOf(this.wallet.address),
    )
    return balance.toString()
  }

  async transferUsdc(to: string, amountWei: string): Promise<string> {
    const receipt = await this.sendTxWithRetry(this.usdc, 'transfer', [to, BigInt(amountWei)])
    return receipt.hash as string
  }

  async settleTask(taskId: string, winners: string[], amounts: string[]): Promise<void> {
    await this.sendTxWithRetry(this.registry, 'requestSettle', [this.formatId(taskId), winners, amounts])
  }

  async challenge(nodeId: string, challengerNodeId?: string): Promise<void> {
    const formattedNodeId = this.formatId(nodeId)
    const node = await this.callWithRetry(() => this.registry.nodes(formattedNodeId))
    const accused = node.claimedBy
    if (accused === ethers.ZeroAddress) throw new Error(`[L2Contract] No claimant found for ${nodeId}`)

    const challengerSubtask = challengerNodeId ? this.formatId(challengerNodeId) : ethers.ZeroHash
    await this.sendTxWithRetry(this.vault, 'challenge', [formattedNodeId, accused, challengerSubtask])
  }

  async resetSubtask(nodeId: string): Promise<void> {
    console.log(`[L2Contract] resetSubtask for ${nodeId} — handled on-chain`)
  }

  async commitVoteOnChallenge(nodeId: string, commitHash: string): Promise<void> {
    const formattedNodeId = this.formatId(nodeId)
    try {
      await this.sendTxWithRetry(this.vault, 'commitVote', [formattedNodeId, commitHash])
    } catch (err: any) {
      console.warn(`[L2Contract] commitVoteOnChallenge skipped: ${err?.message}`)
    }
  }

  /**
   * Cheap eligibility read. Retries once after a 3s delay so a race between
   * AXL gossip and tx mining (peer sees event before challenge tx lands)
   * doesn't false-negative an actual juror selection.
   */
  async isJuryEligible(nodeId: string, address: string): Promise<boolean> {
    const formatted = this.formatId(nodeId)
    try {
      const eligible: boolean = await this.callWithRetry(() =>
        this.vault.isEligibleJuror(formatted, address),
      )
      if (eligible) return true
    } catch (err: any) {
      console.warn(`[L2Contract] isJuryEligible read failed (will retry): ${err?.message}`)
    }
    await new Promise(r => setTimeout(r, 3000))
    try {
      return await this.callWithRetry(() =>
        this.vault.isEligibleJuror(formatted, address),
      )
    } catch (err: any) {
      console.warn(`[L2Contract] isJuryEligible second read failed: ${err?.message}`)
      return false
    }
  }

  async revealVoteOnChallenge(nodeId: string, accusedGuilty: boolean, salt: string): Promise<void> {
    const formattedNodeId = this.formatId(nodeId)
    try {
      await this.sendTxWithRetry(this.vault, 'revealVote', [formattedNodeId, accusedGuilty, salt])
    } catch (err: any) {
      console.warn(`[L2Contract] revealVoteOnChallenge skipped: ${err?.message}`)
    }
  }

  async finalizeChallenge(nodeId: string): Promise<void> {
    try {
      await this.sendTxWithRetry(this.vault, 'finalize', [this.formatId(nodeId)])
    } catch (err: any) {
      console.warn(`[L2Contract] finalizeChallenge skipped: ${err?.message}`)
    }
  }

  async completeTask(_taskId: string): Promise<boolean> {
    return true
  }

  async syncPlannerClaim(_taskId: string, _agentId: string): Promise<void> { }
  async syncSubtaskClaim(_nodeId: string, _agentId: string): Promise<void> { }
  async syncTaskCompletion(_taskId: string, _agentId: string): Promise<void> { }
}
