import Dockerode from 'dockerode'
import { ethers } from 'ethers'
import SwarmEscrowABI from '../../../contracts/artifacts/src/SwarmEscrow.sol/SwarmEscrow.json'
import MockERC20ABI from '../../../contracts/artifacts/src/MockERC20.sol/MockERC20.json'
import AgentRegistryABI from '../../../contracts/artifacts/src/AgentRegistry.sol/AgentRegistry.json'
import deployments from '../../../contracts/deployments/og_testnet.json'
import { AgentSecretStore, AgentSecret } from './AgentSecretStore'

const docker = process.env.DOCKER_HOST
  ? new Dockerode({
    host: process.env.DOCKER_HOST.replace('tcp://', '').split(':')[0],
    port: Number(process.env.DOCKER_HOST.split(':').pop()) || 2375,
  })
  : new Dockerode({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });

const AGENT_IMAGE = process.env.AGENT_IMAGE || 'swarm-agent:latest'
const AGENT_NETWORK = process.env.AGENT_NETWORK || 'swarm_default'
// Compute mode propagated to spawned agents. Default 'central' uses the
// API-side shared broker, so each agent only needs gas for L2 tx (stake,
// claim, submitOutput) — no per-agent ledger sub-account. 'local' falls
// back to the legacy per-agent broker which costs ~3 OG ledger.
const COMPUTE_MODE = (process.env.COMPUTE_MODE ?? 'central').toLowerCase()
// Gas prefund: 3.5 OG was sized for 'local' mode (3 OG ledger min + 0.01
// OG tx headroom). In 'central' mode the agent only needs L2 tx gas, so
// 0.5 OG is plenty. Override with AGENT_GAS_PREFUND_OG if needed.
const GAS_PREFUND_OG =
  process.env.AGENT_GAS_PREFUND_OG ?? (COMPUTE_MODE === 'local' ? '3.5' : '0.1')
// Default model — only qwen variants are reachable on 0G Compute testnet
// at the time of writing.
const DEFAULT_MODEL = process.env.ZG_COMPUTE_MODEL ?? 'qwen/qwen-2.5-7b-instruct'

const STATUS_PENDING = 0
const STATUS_RUNNING = 1
const STATUS_STOPPED = 2
const STATUS_ERROR = 3

const STATUS_NUM_TO_STR: Record<number, AgentRecord['status']> = {
  0: 'pending',
  1: 'running',
  2: 'stopped',
  3: 'error',
}

export interface AgentRecord {
  agentId: string
  name: string
  agentAddress: string
  containerId: string
  model: string
  stakeAmount: string
  systemPrompt?: string
  status: 'pending' | 'running' | 'stopped' | 'error'
  deployedAt: number
  ownerAddress?: string
}

interface PreparedAgent {
  agentId: string
  name: string
  privateKey: string
  agentAddress: string
  model: string
  stakeAmount: string
  systemPrompt?: string
  ownerAddress?: string
  preparedAt: number
}

/**
 * AgentManager handles the lifecycle of Agent containers. Each deploy gets
 * a freshly generated EOA so containers race independently for FCFS claims
 * on-chain — sharing the API wallet would collapse the FCFS into a no-op.
 *
 * Persistence model:
 *   - On-chain `AgentRegistry` is the public source of truth for who exists
 *     and what their status is. Other API nodes / users / explorers read
 *     from there.
 *   - Local encrypted `AgentSecretStore` holds the per-agent private keys
 *     and containerId mapping that's needed to respawn after a restart.
 *     Survives `docker compose down/up` via a named volume.
 *   - Spawned containers carry a `restart: unless-stopped` policy so a
 *     daemon restart brings them back automatically.
 *
 * Two-phase deploy API:
 *   1. prepare() — mints a wallet, prefunds it with native gas, returns
 *      the address so the UI can ask the user to sign a USDC transfer.
 *   2. deploy() — verifies the USDC arrived, spawns the container, persists
 *      the secret, and registers the agent on-chain.
 */
export class AgentManager {
  private prepared = new Map<string, PreparedAgent>()
  private secrets: AgentSecretStore

  private rpcUrl = process.env.OG_RPC_URL || 'https://evmrpc-testnet.0g.ai'
  private fundingPk = process.env.PRIVATE_KEY || ''
  private escrowAddr = process.env.L2_ESCROW_ADDRESS || deployments.SwarmEscrow
  private usdcAddr = process.env.L2_USDC_ADDRESS || deployments.MockUSDC
  private registryAddr = process.env.L2_AGENT_REGISTRY_ADDRESS || (deployments as any).AgentRegistry || ''

  private provider = new ethers.JsonRpcProvider(this.rpcUrl)
  private fundingSigner = this.fundingPk ? new ethers.Wallet(this.fundingPk, this.provider) : null
  private readUsdc = new ethers.Contract(this.usdcAddr, MockERC20ABI.abi, this.provider)
  private registry: ethers.Contract | null
  private cachedDecimals: number | null = null

  constructor() {
    this.secrets = new AgentSecretStore()

    if (this.fundingSigner && this.registryAddr) {
      this.registry = new ethers.Contract(this.registryAddr, AgentRegistryABI.abi, this.fundingSigner)
      console.log(`[AgentManager] AgentRegistry @ ${this.registryAddr}`)
    } else {
      this.registry = null
      console.warn('[AgentManager] AgentRegistry disabled (missing PRIVATE_KEY or L2_AGENT_REGISTRY_ADDRESS) — pool will be local-only')
    }
    console.log(`[AgentManager] Initialized; image=${AGENT_IMAGE} network=${AGENT_NETWORK}`)
  }

  private toBytes32Id(agentId: string): string {
    return ethers.keccak256(ethers.toUtf8Bytes(agentId))
  }

  private async getDecimals(): Promise<number> {
    if (this.cachedDecimals !== null) return this.cachedDecimals
    this.cachedDecimals = Number(await this.readUsdc.decimals())
    return this.cachedDecimals
  }

  /**
   * Force-remove the container associated with a secret, by both id and
   * canonical name. Idempotent — used by restore() when an agent is found
   * to be orphaned (missing on-chain entry, or marked STOPPED/ERROR). The
   * goal is to prevent zombie containers from sticking around in AXL gossip
   * after their on-chain identity has been invalidated by a registry
   * redeploy or status change.
   */
  private async cleanupOrphanContainer(secret: AgentSecret): Promise<void> {
    const targets: string[] = []
    if (secret.containerId) targets.push(secret.containerId)
    targets.push(`swarm-${secret.agentId}`)
    for (const t of targets) {
      try {
        await docker.getContainer(t).remove({ force: true })
        console.log(`[AgentManager] removed orphan container ${t} for ${secret.agentId}`)
        return
      } catch {
        // try the next target (id may be stale; name fallback handles that)
      }
    }
  }

  private buildContainerEnv(secret: AgentSecret): string[] {
    const env = [
      `AGENT_ID=${secret.agentId}`,
      `STAKE_AMOUNT=${secret.stakeAmount}`,
      `AGENT_PRIVATE_KEY=${secret.privateKey}`,
      // L2Contract reads PRIVATE_KEY for the signer — same as the agent's wallet.
      `PRIVATE_KEY=${secret.privateKey}`,
      `ZG_COMPUTE_MODEL=${secret.model}`,
      `ZG_COMPUTE_RPC_URL=${process.env.ZG_COMPUTE_RPC_URL ?? 'https://evmrpc-testnet.0g.ai'}`,
      `OG_RPC_URL=${process.env.OG_RPC_URL ?? 'https://evmrpc-testnet.0g.ai'}`,
      `OG_INDEXER_URL=${process.env.OG_INDEXER_URL ?? 'https://indexer-storage-testnet-turbo.0g.ai'}`,
      `USE_ZG_STORAGE=${process.env.USE_ZG_STORAGE ?? 'true'}`,
      `STORAGE_FALLBACK=${process.env.STORAGE_FALLBACK ?? 'true'}`,
      `USE_L2=${process.env.USE_L2 ?? 'true'}`,
      // Spawned agents must always run the real runtime — they hold real USDC.
      `USE_MOCK=false`,
      `COMPUTE_MODE=${COMPUTE_MODE}`,
      `AXL_PEER=${process.env.AXL_PEER ?? 'tcp://axl-seed:7000'}`,
      `AXL_URL=${process.env.AXL_URL ?? 'http://localhost:9002'}`,
      `L2_USDC_ADDRESS=${this.usdcAddr}`,
      `L2_ESCROW_ADDRESS=${this.escrowAddr}`,
      `L2_DAG_REGISTRY_ADDRESS=${process.env.L2_DAG_REGISTRY_ADDRESS ?? deployments.DAGRegistry}`,
      `L2_SLASHING_VAULT_ADDRESS=${process.env.L2_SLASHING_VAULT_ADDRESS ?? deployments.SlashingVault}`,
      // Tooling — propagate web search keys + internal API URL so spawned
      // agents can hit the CodeExecutor sandbox and run real web search.
      `TAVILY_API_KEY=${process.env.TAVILY_API_KEY ?? ''}`,
      `BRAVE_API_KEY=${process.env.BRAVE_API_KEY ?? ''}`,
      `API_INTERNAL_URL=${process.env.API_INTERNAL_URL ?? 'http://api:3001'}`,
    ]
    if (secret.systemPrompt) env.push(`AGENT_SYSTEM_PROMPT=${secret.systemPrompt}`)
    // Owner wallet — surplus auto-payout target inside SwarmAgent. Without
    // it, the agent's earnings stay in the agent wallet until manual withdraw.
    if (secret.ownerAddress) env.push(`OWNER_ADDRESS=${secret.ownerAddress}`)
    return env
  }

  private async createAndStartContainer(secret: AgentSecret): Promise<string> {
    const containerName = `swarm-${secret.agentId}`
    // If a stale container with this name already exists (e.g. left over from
    // a `docker compose down` that removed the volume entry but not the
    // container), force-remove before recreating so naming doesn't collide.
    try {
      await docker.getContainer(containerName).remove({ force: true })
    } catch {
      // No existing container — expected on a fresh deploy.
    }

    const container = await docker.createContainer({
      Image: AGENT_IMAGE,
      name: containerName,
      Env: this.buildContainerEnv(secret),
      HostConfig: {
        NetworkMode: AGENT_NETWORK,
        AutoRemove: false,
        // Survive Docker daemon restarts. Stops only on explicit `docker stop`
        // or our DELETE /agent/:id flow.
        RestartPolicy: { Name: 'unless-stopped' },
      },
    })
    await container.start()
    return container.id
  }

  private recordFromSecret(secret: AgentSecret, status: AgentRecord['status']): AgentRecord {
    return {
      agentId: secret.agentId,
      name: secret.name,
      agentAddress: secret.agentAddress,
      containerId: secret.containerId ?? '',
      model: secret.model,
      stakeAmount: secret.stakeAmount,
      systemPrompt: secret.systemPrompt,
      status,
      deployedAt: secret.preparedAt,
      ownerAddress: secret.ownerAddress,
    }
  }

  /**
   * Generates a fresh wallet for the agent and prefunds it with native gas
   * so the spawned container can pay for stake/claim transactions. Returns
   * the agent's on-chain address; the caller (UI) must then sign a USDC
   * transfer to this address before calling deploy().
   */
  async prepare(input: {
    name: string
    model?: string
    stakeAmount: string
    systemPrompt?: string
    ownerAddress?: string
  }): Promise<{
    agentId: string
    agentAddress: string
    usdcAddress: string
    decimals: number
    stakeWei: string
    gasPrefundOG: string
  }> {
    const slug = input.name.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 24) || 'agent'
    const agentId = `${slug}-${Date.now().toString(36)}`

    const wallet = ethers.Wallet.createRandom()
    const record: PreparedAgent = {
      agentId,
      name: input.name,
      privateKey: wallet.privateKey,
      agentAddress: wallet.address,
      model: input.model ?? DEFAULT_MODEL,
      stakeAmount: input.stakeAmount,
      systemPrompt: input.systemPrompt,
      ownerAddress: input.ownerAddress,
      preparedAt: Date.now(),
    }
    this.prepared.set(agentId, record)

    // Best-effort gas prefund. If it fails the user can still transfer USDC,
    // but the agent will be unable to submit txs until topped up another way.
    // tx.wait() is intentionally NOT awaited here — 0G testnet block times
    // can exceed 30s and blocking the prepare() call causes the UI to show
    // "Transaction receipt not found". The transfer is sent and confirmed in
    // the background; the agent container starts a few seconds later and by
    // then the funds are almost always available.
    // Prefund must succeed before prepare() returns — otherwise we leak
    const decimals = await this.getDecimals()
    const stakeWei = ethers.parseUnits(input.stakeAmount, decimals).toString()

    if (!this.fundingSigner) {
      throw new Error('[AgentManager] PRIVATE_KEY missing — cannot prefund agent gas')
    }

    // We ONLY prefund native gas (OG) here — the agent's wallet needs gas to
    // submit L2 tx (claim, stake, submitOutput). USDC stake comes from the
    // user via DeployAgentModal's signed `usdc.transfer` immediately after
    // this prepare() returns. Auto-funding USDC from the API wallet here
    // would mean the user's transfer is redundant — they could reject the
    // popup and deploy() would still pass the balance check, leaving
    // operations effectively free for the user. Stick to gas-only prefund.
    try {
      const tx = await this.fundingSigner.sendTransaction({
        to: wallet.address,
        value: ethers.parseEther(GAS_PREFUND_OG),
      })
      console.log(`[AgentManager] Prefund TX sent: ${tx.hash} → ${wallet.address} (${GAS_PREFUND_OG} OG)`)
      await tx.wait()
      console.log(`[AgentManager] Prefund confirmed for ${wallet.address} — awaiting user-signed USDC stake`)
    } catch (err) {
      throw new Error(`[AgentManager] Gas prefund failed for ${wallet.address}: ${(err as Error).message}`)
    }

    return {
      agentId,
      agentAddress: wallet.address,
      usdcAddress: this.usdcAddr,
      decimals,
      stakeWei,
      gasPrefundOG: GAS_PREFUND_OG,
    }
  }

  /**
   * Verifies the prepared agent's USDC balance covers the requested stake,
   * spawns its Docker container, persists the secret, and publishes the
   * agent on-chain so the pool is visible to other readers.
   */
  async deploy(agentId: string): Promise<AgentRecord> {
    const prep = this.prepared.get(agentId)
    if (!prep) throw new Error(`Agent ${agentId} not prepared (call /agent/prepare first)`)

    const decimals = await this.getDecimals()
    const required = ethers.parseUnits(prep.stakeAmount, decimals)
    const balance: bigint = await this.readUsdc.balanceOf(prep.agentAddress)
    if (balance < required) {
      throw new Error(
        `Agent ${prep.agentAddress} has ${ethers.formatUnits(balance, decimals)} USDC but needs ${prep.stakeAmount}. Transfer USDC first.`,
      )
    }

    const secret: AgentSecret = {
      agentId: prep.agentId,
      privateKey: prep.privateKey,
      name: prep.name,
      model: prep.model,
      stakeAmount: prep.stakeAmount,
      systemPrompt: prep.systemPrompt,
      ownerAddress: prep.ownerAddress,
      agentAddress: prep.agentAddress,
      preparedAt: prep.preparedAt,
    }

    const containerId = await this.createAndStartContainer(secret)
    secret.containerId = containerId
    // Persist the secret BEFORE attempting on-chain register so a chain
    // failure doesn't leave us with a running container we can't recover.
    this.secrets.save(secret)

    // Background the on-chain registration: 0G testnet confirmations take
    // 5–10s per tx, and the agent is already functional once the container
    // is up. Returning early here keeps the deploy modal snappy. If the
    // chain calls fail, restore() on the next API start retries them.
    if (this.registry) {
      this.registerOnChainAsync(secret).catch(err => {
        console.error(`[AgentManager] background register failed for ${secret.agentId}:`, err)
      })
    }

    this.prepared.delete(agentId)
    console.log(`[AgentManager] Deployed ${prep.agentId} → container ${containerId} addr=${prep.agentAddress}`)
    // Surface as 'pending' — list() will lift to 'running' once the chain
    // tx confirms. The merge in list() also returns local-only agents so
    // the UI sees the new entry immediately.
    return this.recordFromSecret(secret, 'pending')
  }

  /**
   * Background-only path that publishes a freshly-deployed agent to the
   * on-chain registry. Skipped silently if `this.registry` is unavailable.
   * Intentionally awaits both txs so failures are observable in logs and
   * surface to the orphan/PENDING sweep in restore().
   */
  private async registerOnChainAsync(secret: AgentSecret): Promise<void> {
    if (!this.registry) return
    const id = this.toBytes32Id(secret.agentId)
    const decimals = await this.getDecimals()
    const stakeWei = ethers.parseUnits(secret.stakeAmount, decimals)
    const tx = await this.registry.register(id, secret.agentAddress, secret.name, secret.model, stakeWei)
    await tx.wait()
    const tx2 = await this.registry.setStatus(id, STATUS_RUNNING)
    await tx2.wait()
    console.log(`[AgentManager] Registered ${secret.agentId} on-chain @ ${this.registryAddr}`)
  }

  /**
   * Owner-address lookup for the auth gate on /agent/:id endpoints. Returns
   * null when no secret is held locally (e.g. the agent was registered
   * elsewhere or was already stopped) — callers should treat that as
   * "no auth requirement enforceable, fall through to best-effort".
   */
  getSecretMeta(idOrContainerId: string): { agentId: string; ownerAddress?: string } | null {
    let secret = this.secrets.get(idOrContainerId)
    if (!secret) {
      secret = this.secrets.list().find(s => s.containerId === idOrContainerId)
    }
    if (!secret) return null
    return { agentId: secret.agentId, ownerAddress: secret.ownerAddress }
  }

  /**
   * Drain an agent's wallet to its owner. Used by both the explicit user
   * "Withdraw" flow (partial USDC) and the "Stop" flow (full USDC + OG, with
   * a small gas reserve so the drain tx itself can land).
   *
   * Returns whichever sub-drains actually moved funds. Errors inside one
   * drain (USDC fails but OG succeeds, say) are logged and the other path
   * continues — better partial recovery than total abort.
   */
  private async drainAgentToOwner(
    secret: AgentSecret,
    opts?: { partialUsdcWei?: bigint; skipOg?: boolean },
  ): Promise<{
    usdc?: { txHash: string; amountWei: string }
    og?: { txHash: string; amountWei: string }
  }> {
    const result: {
      usdc?: { txHash: string; amountWei: string }
      og?: { txHash: string; amountWei: string }
    } = {}
    if (!secret.ownerAddress) {
      console.warn(`[AgentManager] drain skipped for ${secret.agentId}: no ownerAddress`)
      return result
    }

    const wallet = new ethers.Wallet(secret.privateKey, this.provider)
    const usdc = new ethers.Contract(this.usdcAddr, MockERC20ABI.abi, wallet)

    // USDC sweep
    try {
      const balance: bigint = await usdc.balanceOf(wallet.address)
      const target = opts?.partialUsdcWei ?? balance
      if (target > 0n && target <= balance) {
        const tx = await usdc.transfer(secret.ownerAddress, target)
        await tx.wait()
        result.usdc = { txHash: tx.hash, amountWei: target.toString() }
        console.log(`[AgentManager] Drained ${target.toString()} USDC wei → ${secret.ownerAddress} (${secret.agentId})`)
      }
    } catch (err) {
      console.error(`[AgentManager] USDC drain failed for ${secret.agentId}:`, err)
    }

    // Native OG sweep — only on full drain, leaves a tx-cost reserve so the
    // drain tx itself can settle on-chain. partialUsdcWei callers explicitly
    // skip this because they only wanted to move USDC.
    if (!opts?.skipOg && opts?.partialUsdcWei === undefined) {
      try {
        const balance = await this.provider.getBalance(wallet.address)
        const feeData = await this.provider.getFeeData()
        const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas ?? ethers.parseUnits('1', 'gwei')
        const reserve = 21000n * gasPrice * 2n // headroom for the transfer itself
        if (balance > reserve) {
          const amount = balance - reserve
          const tx = await wallet.sendTransaction({
            to: secret.ownerAddress,
            value: amount,
            gasLimit: 21000n,
          })
          await tx.wait()
          result.og = { txHash: tx.hash, amountWei: amount.toString() }
          console.log(`[AgentManager] Drained ${amount.toString()} OG wei → ${secret.ownerAddress} (${secret.agentId})`)
        }
      } catch (err) {
        console.error(`[AgentManager] OG drain failed for ${secret.agentId}:`, err)
      }
    }

    return result
  }

  /**
   * User-initiated USDC withdrawal from an agent's wallet to the owner.
   * Auth check: requesterAddress must equal secret.ownerAddress. amountStr
   * is a decimal string (e.g. "5.5"); omit it to drain the full USDC balance
   * (does NOT touch OG — for that, use stop()).
   */
  async withdraw(
    agentId: string,
    requesterAddress: string,
    amountStr?: string,
  ): Promise<{ txHash: string; amountWei: string }> {
    const secret = this.secrets.get(agentId)
    if (!secret) throw new Error(`Agent ${agentId} not found`)
    if (!secret.ownerAddress) throw new Error('Agent has no registered owner')
    if (secret.ownerAddress.toLowerCase() !== requesterAddress.toLowerCase()) {
      throw new Error('Not authorized — requester is not the agent owner')
    }

    const decimals = await this.getDecimals()
    let partialUsdcWei: bigint | undefined
    if (amountStr) {
      try {
        partialUsdcWei = ethers.parseUnits(amountStr, decimals)
      } catch (err) {
        throw new Error(`Invalid amount "${amountStr}": ${(err as Error).message}`)
      }
      if (partialUsdcWei <= 0n) throw new Error('Amount must be > 0')
    }

    const drained = await this.drainAgentToOwner(secret, { partialUsdcWei, skipOg: true })
    if (!drained.usdc) {
      throw new Error('Withdraw produced no transfer (zero balance or partial > balance)')
    }
    return drained.usdc
  }

  /**
   * Record a user-signed USDC deposit. The frontend signs `usdc.transfer`
   * to the agent address itself; we just bump our local floor so the surplus
   * watchdog doesn't immediately sweep the deposit back. Container is
   * restarted so SwarmAgent reads the new STAKE_AMOUNT env on boot.
   *
   * Auth: requesterAddress must equal secret.ownerAddress. amountStr is a
   * positive decimal string.
   */
  async recordDeposit(
    agentId: string,
    requesterAddress: string,
    amountStr: string,
  ): Promise<{ newStakeAmount: string }> {
    const secret = this.secrets.get(agentId)
    if (!secret) throw new Error(`Agent ${agentId} not found`)
    if (!secret.ownerAddress) throw new Error('Agent has no registered owner')
    if (secret.ownerAddress.toLowerCase() !== requesterAddress.toLowerCase()) {
      throw new Error('Not authorized — requester is not the agent owner')
    }

    const addAmount = parseFloat(amountStr)
    if (!Number.isFinite(addAmount) || addAmount <= 0) {
      throw new Error('Amount must be a positive decimal')
    }
    const newStake = (parseFloat(secret.stakeAmount) + addAmount).toString()
    this.secrets.update(agentId, { stakeAmount: newStake })

    // Restart so SwarmAgent picks up the new floor — without this, the next
    // surplus sweep tick would treat the deposit as reward and forward it
    // straight back to the owner.
    if (secret.containerId) {
      try {
        const c = docker.getContainer(secret.containerId)
        await c.restart()
        console.log(`[AgentManager] Restarted ${secret.agentId} to pick up new stake floor ${newStake}`)
      } catch (err) {
        console.warn(`[AgentManager] Restart failed for ${secret.agentId} (deposit recorded anyway):`, err)
      }
    }

    return { newStakeAmount: newStake }
  }

  /**
   * Stops and removes an agent. Accepts either the agentId (string) or the
   * containerId, since the existing API contract used containerId. Marks the
   * on-chain status as STOPPED and purges the local secret. Drains both
   * USDC and remaining OG (minus a gas reserve) to the owner first so the
   * funds aren't stranded with the dead container.
   */
  async stop(idOrContainerId: string): Promise<{
    drained?: {
      usdc?: { txHash: string; amountWei: string }
      og?: { txHash: string; amountWei: string }
    }
  }> {
    let secret = this.secrets.get(idOrContainerId)
    if (!secret) {
      secret = this.secrets.list().find(s => s.containerId === idOrContainerId)
    }

    // Drain BEFORE stopping the container — once the on-chain status flips
    // to STOPPED there's nothing wrong with the wallet still moving funds,
    // but we want the drain happening while the secret is still in our hot
    // path. Errors inside drain don't block the stop sequence.
    let drained: { usdc?: { txHash: string; amountWei: string }; og?: { txHash: string; amountWei: string } } | undefined
    if (secret && secret.ownerAddress) {
      drained = await this.drainAgentToOwner(secret)
    }

    const containerId = secret?.containerId ?? idOrContainerId
    if (containerId) {
      try {
        const c = docker.getContainer(containerId)
        await c.stop()
        await c.remove()
      } catch (err) {
        console.warn(`[AgentManager] Container ${containerId} stop error:`, err)
      }
    }

    if (this.registry && secret) {
      try {
        const id = this.toBytes32Id(secret.agentId)
        const tx = await this.registry.setStatus(id, STATUS_STOPPED)
        await tx.wait()
      } catch (err) {
        console.error(`[AgentManager] On-chain setStatus(STOPPED) failed for ${secret.agentId}:`, err)
      }
    }

    if (secret) this.secrets.delete(secret.agentId)

    return { drained }
  }

  /**
   * Returns the public agent pool. Merges the on-chain registry (public
   * truth) with the local secret store so freshly-deployed agents show up
   * immediately as `pending`, even before their background register tx
   * has confirmed. Cross-checks with live Docker state to demote agents
   * whose container has vanished.
   */
  async list(): Promise<AgentRecord[]> {
    const localSecrets = this.secrets.list()
    const localById = new Map<string, AgentSecret>()
    for (const s of localSecrets) {
      localById.set(this.toBytes32Id(s.agentId), s)
    }

    let runningContainerIds: Set<string>
    let dockerOk = true
    try {
      const live = await docker.listContainers()
      runningContainerIds = new Set(live.map(c => c.Id))
    } catch {
      runningContainerIds = new Set()
      dockerOk = false
    }

    let onChainIds: string[] = []
    let onChainAgents: any[] = []
    if (this.registry) {
      try {
        const result = await this.registry.listAgents(0, 0)
        onChainIds = result[0]
        onChainAgents = result[1]
      } catch (err) {
        console.warn('[AgentManager] registry.listAgents failed; using local secrets only:', err)
      }
    }

    const decimals = await this.getDecimals().catch(() => 18)
    const records: AgentRecord[] = []
    const seenLocal = new Set<string>()

    for (let i = 0; i < onChainIds.length; i++) {
      const id = onChainIds[i]
      const a = onChainAgents[i]
      let status = STATUS_NUM_TO_STR[Number(a.status)] ?? 'error'

      const secret = localById.get(id)
      const containerId = secret?.containerId ?? ''
      // If on-chain says RUNNING but the container is gone locally, surface
      // as STOPPED — restore() on next API start will reconcile the truth.
      if (status === 'running' && containerId && dockerOk && !runningContainerIds.has(containerId)) {
        status = 'stopped'
      }

      records.push({
        agentId: secret?.agentId ?? id,
        name: a.name,
        agentAddress: a.agentAddress,
        containerId,
        model: a.model,
        stakeAmount: ethers.formatUnits(a.stakeAmount, decimals),
        status,
        deployedAt: Number(a.deployedAt) * 1000,
        ownerAddress: a.owner,
      })
      if (secret) seenLocal.add(secret.agentId)
    }

    // Local secrets that haven't reached the chain yet (background register
    // still in flight, or registry unreachable). Show as 'pending' so the
    // UI sees them immediately after deploy.
    for (const s of localSecrets) {
      if (seenLocal.has(s.agentId)) continue
      const containerLive = s.containerId && (!dockerOk || runningContainerIds.has(s.containerId))
      records.push(this.recordFromSecret(s, containerLive ? 'pending' : 'stopped'))
    }

    return records
  }

  /**
   * Reconcile state at API startup:
   *   1. Walk the local secret store; for each agent, check on-chain status.
   *      - STOPPED / ERROR → drop the local secret.
   *      - RUNNING → ensure the container is up; respawn if missing.
   *   2. Detect orphans (registry entries owned by this API wallet, status
   *      RUNNING, but no local secret) and mark them ERROR on-chain so the
   *      pool reflects reality.
   */
  async restore(): Promise<void> {
    if (!this.registry) {
      console.warn('[AgentManager] restore() skipped — registry disabled')
      return
    }

    const secrets = this.secrets.list()
    console.log(`[AgentManager] Restoring ${secrets.length} agent(s) from secret store...`)

    let containers: Map<string, Dockerode.ContainerInfo>
    try {
      const live = await docker.listContainers({ all: true })
      containers = new Map(live.map(c => [c.Id, c]))
    } catch (err) {
      console.error('[AgentManager] docker.listContainers failed during restore:', err)
      return
    }

    for (const secret of secrets) {
      const onChainId = this.toBytes32Id(secret.agentId)

      // exists() lets us distinguish "never registered" (background register
      // crashed mid-flight) from "registered with a status we should react to".
      let onChainExists: boolean
      try {
        onChainExists = await this.registry.exists(onChainId)
      } catch (err) {
        console.warn(`[AgentManager] registry.exists failed for ${secret.agentId}:`, err)
        continue
      }

      if (!onChainExists) {
        // Orphan: the on-chain registry has no record of this agent. The
        // most common cause is a registry redeploy that wiped state but
        // left our encrypted secret store + container running. We used to
        // optimistically retry register here; that produced "zombie" agents
        // visible in AXL gossip but absent from the public pool. Now we
        // tear them down so the cluster reflects on-chain truth.
        console.warn(`[AgentManager] orphan secret ${secret.agentId} (no on-chain entry); removing container + secret`)
        await this.cleanupOrphanContainer(secret)
        this.secrets.delete(secret.agentId)
        continue
      } else {
        const agent = await this.registry.getAgent(onChainId)
        const status = Number(agent.status)
        if (status === STATUS_STOPPED || status === STATUS_ERROR) {
          console.log(`[AgentManager] Cleaning up inactive ${secret.agentId} (status=${status})`)
          await this.cleanupOrphanContainer(secret)
          this.secrets.delete(secret.agentId)
          continue
        }
        // PENDING means the prior deploy's setStatus(RUNNING) tx never landed.
        // Lift it now so external readers see the right state.
        if (status === STATUS_PENDING) {
          try {
            const tx = await this.registry.setStatus(onChainId, STATUS_RUNNING)
            await tx.wait()
            console.log(`[AgentManager] Lifted ${secret.agentId} from PENDING to RUNNING`)
          } catch (err) {
            console.error(`[AgentManager] setStatus(RUNNING) on restore failed for ${secret.agentId}:`, err)
          }
        }
      }

      const liveContainer = secret.containerId ? containers.get(secret.containerId) : undefined
      try {
        if (liveContainer) {
          if (liveContainer.State !== 'running') {
            console.log(`[AgentManager] Starting container ${liveContainer.Id.slice(0, 12)} for ${secret.agentId}`)
            await docker.getContainer(liveContainer.Id).start()
          } else {
            console.log(`[AgentManager] Agent ${secret.agentId} already running`)
          }
        } else {
          console.log(`[AgentManager] Respawning container for ${secret.agentId}`)
          const newId = await this.createAndStartContainer(secret)
          this.secrets.update(secret.agentId, { containerId: newId })
        }
      } catch (err) {
        console.error(`[AgentManager] Failed to restore ${secret.agentId}:`, err)
        if (onChainExists) {
          try {
            const tx = await this.registry.setStatus(onChainId, STATUS_ERROR)
            await tx.wait()
            console.warn(`[AgentManager] Marked ${secret.agentId} as ERROR on-chain`)
          } catch (chainErr) {
            console.error(`[AgentManager] Failed to mark ${secret.agentId} ERROR:`, chainErr)
          }
        }
        // Whether the on-chain mark succeeded or not, the local container
        // is in an unrecoverable state (failed to start) — clear it out
        // so subsequent restore() runs don't loop on the same broken entry.
        await this.cleanupOrphanContainer(secret)
        this.secrets.delete(secret.agentId)
      }
    }

    // Orphan sweep: agents we own on-chain but have no secret for. Marking
    // them ERROR is the only signal we can give downstream readers that the
    // record is dead — we can't actually bring them back without the key.
    if (!this.fundingSigner) return
    const ourAddr = this.fundingSigner.address.toLowerCase()
    const haveSecret = new Set(secrets.map(s => this.toBytes32Id(s.agentId)))
    try {
      const [ids, agents] = await this.registry.listAgents(0, 0)
      for (let i = 0; i < ids.length; i++) {
        const a = agents[i]
        if (Number(a.status) !== STATUS_RUNNING) continue
        if (a.owner.toLowerCase() !== ourAddr) continue
        if (haveSecret.has(ids[i])) continue
        console.warn(`[AgentManager] Orphan ${ids[i]} (no local secret). Marking ERROR.`)
        try {
          const tx = await this.registry.setStatus(ids[i], STATUS_ERROR)
          await tx.wait()
        } catch (err) {
          console.error(`[AgentManager] orphan setStatus(ERROR) failed for ${ids[i]}:`, err)
        }
      }
    } catch (err) {
      console.error('[AgentManager] orphan sweep failed:', err)
    }
  }
}
