import Dockerode from 'dockerode'
import { ethers } from 'ethers'
import SwarmEscrowABI from '../../../contracts/artifacts/src/SwarmEscrow.sol/SwarmEscrow.json'
import MockERC20ABI from '../../../contracts/artifacts/src/MockERC20.sol/MockERC20.json'
import deployments from '../../../contracts/deployments/og_testnet.json'

const docker = process.env.DOCKER_HOST
  ? new Dockerode({
    host: process.env.DOCKER_HOST.replace('tcp://', '').split(':')[0],
    port: Number(process.env.DOCKER_HOST.split(':').pop()) || 2375,
  })
  : new Dockerode({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });

const AGENT_IMAGE = process.env.AGENT_IMAGE || 'swarm-agent:latest'
const AGENT_NETWORK = process.env.AGENT_NETWORK || 'swarm_default'
// Default 3.5 OG: 3 OG goes into the 0G Compute ledger sub-account on the
// agent's first inference call (SDK minimum), the rest covers tx gas for
// stake/claim/submitOutput across the agent's lifetime. Override per-deploy
// with AGENT_GAS_PREFUND_OG if your API wallet is short on OG.
const GAS_PREFUND_OG = process.env.AGENT_GAS_PREFUND_OG ?? '3.5'
// Default model — only qwen variants are reachable on 0G Compute testnet
// at the time of writing.
const DEFAULT_MODEL = process.env.ZG_COMPUTE_MODEL ?? 'qwen/qwen-2.5-7b-instruct'

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
 * Two-phase API:
 *   1. prepare() — mints a wallet, prefunds it with native gas, returns
 *      the address so the UI can ask the user to sign a USDC transfer.
 *   2. deploy() — verifies the USDC arrived, then spawns the container.
 */
export class AgentManager {
  private prepared = new Map<string, PreparedAgent>()
  private records = new Map<string, AgentRecord>()  // containerId → record

  private rpcUrl = process.env.OG_RPC_URL || 'https://evmrpc-testnet.0g.ai'
  private fundingPk = process.env.PRIVATE_KEY || ''
  private escrowAddr = process.env.L2_ESCROW_ADDRESS || deployments.SwarmEscrow
  private usdcAddr = process.env.L2_USDC_ADDRESS || deployments.MockUSDC

  private provider = new ethers.JsonRpcProvider(this.rpcUrl)
  private fundingSigner = this.fundingPk ? new ethers.Wallet(this.fundingPk, this.provider) : null
  private readUsdc = new ethers.Contract(this.usdcAddr, MockERC20ABI.abi, this.provider)

  constructor() {
    console.log(`[AgentManager] Initialized; image=${AGENT_IMAGE} network=${AGENT_NETWORK}`)
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
    if (this.fundingSigner) {
      try {
        const tx = await this.fundingSigner.sendTransaction({
          to: wallet.address,
          value: ethers.parseEther(GAS_PREFUND_OG),
        })
        await tx.wait()
        console.log(`[AgentManager] Prefunded ${GAS_PREFUND_OG} OG to ${wallet.address} (tx ${tx.hash})`)
      } catch (err) {
        console.error(`[AgentManager] Gas prefund failed for ${wallet.address}:`, err)
      }
    } else {
      console.warn('[AgentManager] PRIVATE_KEY missing — agent will start without gas prefund')
    }

    // Resolve USDC decimals so the UI knows how to scale the stakeAmount
    // for the on-chain transfer call. Cached after first read.
    const decimals = Number(await this.readUsdc.decimals())
    const stakeWei = ethers.parseUnits(input.stakeAmount, decimals).toString()

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
   * then spawns its Docker container with a unique AGENT_PRIVATE_KEY env var.
   */
  async deploy(agentId: string): Promise<AgentRecord> {
    const prep = this.prepared.get(agentId)
    if (!prep) throw new Error(`Agent ${agentId} not prepared (call /agent/prepare first)`)

    // Verify on-chain that the user transferred USDC to the agent's address.
    const decimals = Number(await this.readUsdc.decimals())
    const required = ethers.parseUnits(prep.stakeAmount, decimals)
    const balance: bigint = await this.readUsdc.balanceOf(prep.agentAddress)
    if (balance < required) {
      throw new Error(
        `Agent ${prep.agentAddress} has ${ethers.formatUnits(balance, decimals)} USDC but needs ${prep.stakeAmount}. Transfer USDC first.`,
      )
    }

    const env = [
      `AGENT_ID=${prep.agentId}`,
      `STAKE_AMOUNT=${prep.stakeAmount}`,
      `AGENT_PRIVATE_KEY=${prep.privateKey}`,
      // L2Contract reads PRIVATE_KEY for the signer — same as the agent's wallet.
      `PRIVATE_KEY=${prep.privateKey}`,
      `ZG_COMPUTE_MODEL=${prep.model}`,
      `ZG_COMPUTE_RPC_URL=${process.env.ZG_COMPUTE_RPC_URL ?? 'https://evmrpc-testnet.0g.ai'}`,
      `OG_RPC_URL=${process.env.OG_RPC_URL ?? 'https://evmrpc-testnet.0g.ai'}`,
      `OG_INDEXER_URL=${process.env.OG_INDEXER_URL ?? 'https://indexer-storage-testnet-turbo.0g.ai'}`,
      `USE_ZG_STORAGE=${process.env.USE_ZG_STORAGE ?? 'true'}`,
      `STORAGE_FALLBACK=${process.env.STORAGE_FALLBACK ?? 'true'}`,
      `USE_L2=${process.env.USE_L2 ?? 'true'}`,
      // Spawned agents must always run the real runtime — they hold real USDC.
      `USE_MOCK=false`,
      `AXL_PEER=${process.env.AXL_PEER ?? 'tcp://axl-seed:7000'}`,
      `AXL_URL=${process.env.AXL_URL ?? 'http://localhost:9002'}`,
      `L2_USDC_ADDRESS=${this.usdcAddr}`,
      `L2_ESCROW_ADDRESS=${this.escrowAddr}`,
      `L2_DAG_REGISTRY_ADDRESS=${process.env.L2_DAG_REGISTRY_ADDRESS ?? deployments.DAGRegistry}`,
      `L2_SLASHING_VAULT_ADDRESS=${process.env.L2_SLASHING_VAULT_ADDRESS ?? deployments.SlashingVault}`,
    ]
    if (prep.systemPrompt) env.push(`AGENT_SYSTEM_PROMPT=${prep.systemPrompt}`)

    const container = await docker.createContainer({
      Image: AGENT_IMAGE,
      name: `swarm-${prep.agentId}`,
      Env: env,
      HostConfig: {
        NetworkMode: AGENT_NETWORK,
        AutoRemove: false,
      },
    })

    await container.start()

    const record: AgentRecord = {
      agentId: prep.agentId,
      name: prep.name,
      agentAddress: prep.agentAddress,
      containerId: container.id,
      model: prep.model,
      stakeAmount: prep.stakeAmount,
      systemPrompt: prep.systemPrompt,
      status: 'running',
      deployedAt: Date.now(),
      ownerAddress: prep.ownerAddress,
    }
    this.records.set(container.id, record)
    this.prepared.delete(agentId)

    console.log(`[AgentManager] Deployed ${prep.agentId} → container ${container.id} addr=${prep.agentAddress}`)
    return record
  }

  async stop(containerId: string): Promise<void> {
    const c = docker.getContainer(containerId)
    try {
      await c.stop()
      await c.remove()
    } catch (err) {
      console.warn(`[AgentManager] Container ${containerId} stop error:`, err)
    }
    const rec = this.records.get(containerId)
    if (rec) rec.status = 'stopped'
    this.records.delete(containerId)
  }

  async list(): Promise<AgentRecord[]> {
    const records = Array.from(this.records.values())
    let runningIds: Set<string>
    try {
      const live = await docker.listContainers()
      runningIds = new Set(live.map(c => c.Id))
    } catch (err) {
      // Docker daemon unreachable — return last-known state without flipping
      // statuses, so a transient outage doesn't make the pool blink offline.
      console.warn('[AgentManager] docker.listContainers failed; returning cached records')
      return records
    }
    return records.map(r => ({
      ...r,
      status: runningIds.has(r.containerId) ? 'running' : 'stopped',
    }))
  }
}
