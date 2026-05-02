/**
 * `Spore` — the canonical user-facing entry point.
 *
 *   import { Spore, LangChainAgent } from '@spore/sdk'
 *   import { ChatOpenAI } from '@langchain/openai'
 *   import { createReactAgent } from '@langchain/langgraph/prebuilt'
 *
 *   const spore = new Spore({ apiKey: process.env.SPORE_API_KEY! })
 *
 *   const llm = new ChatOpenAI({ model: 'gpt-4o-mini' })
 *   spore.sporeise(
 *     new LangChainAgent({ id: 'a1', agent: createReactAgent({ llm, tools: [] }), llm }),
 *     new LangChainAgent({ id: 'a2', agent: createReactAgent({ llm, tools: [] }), llm }),
 *     new LangChainAgent({ id: 'a3', agent: createReactAgent({ llm, tools: [] }), llm }),
 *     new LangChainAgent({ id: 'a4', agent: createReactAgent({ llm, tools: [] }), llm }),
 *   )
 *
 *   const { result } = await spore.run('build something')
 *
 * What this class does for you behind a single API key:
 *   - Auto-mints an EOA per agent the first time it's needed (or loads
 *     from an opt-in JSON store across restarts).
 *   - Posts every chain-side state transition to the SPORE service —
 *     register-agents, submit-task, register-dag, submit-node-output,
 *     submit-validations, complete-task. Service operator pays gas
 *     and bills it back to your API key's Treasury balance.
 *   - Drives the homogeneous agent pool through the FCFS-emergent
 *     planner → workers ⇄ validators → completed lifecycle locally.
 *     Validators sign their verdicts on YOUR machine with the
 *     SDK-minted key, so the on-chain BFT property survives even if
 *     the service operator misbehaves.
 *
 * What you do NOT manage: operator private keys, coordinator addresses,
 * agent wallets, validator signing keys, gas, USDC budgets,
 * settlement, slashing. None of it.
 */

import {
  Orchestrator,
  type ExecuteOptions,
  type SporeAgent,
  type SporeEvent,
  type SporeEventHandler,
  type SporeEventType,
  type SporeOptions,
  type TaskResult,
  type ValidationSignPayload,
  type ValidationVerdict,
} from './swarm'
import {
  SwarmTransport,
  type RegisterAgentInput,
  type ValidatorVoteWire,
} from './swarm-transport'
import { WalletStore } from './wallet-store'

type EthersModule = typeof import('ethers')

export interface SporeManagedOptions extends SporeOptions {
  /** Plaintext SPORE API key (`sk_live_...` / `sk_test_...`). The service
   *  authenticates every chain op against it and bills gas back to
   *  the bound Treasury balance. */
  apiKey: string
  /** Override the SPORE API base URL. Default: `https://api.sporeprotocol.xyz`. */
  baseUrl?: string
  /** Opt-in path for persisting auto-generated agent wallets to disk
   *  (e.g. `'.spore-wallets.json'`). Without it, wallets are EPHEMERAL
   *  — agent reputation accrues against fresh ids each run. Add the
   *  file to your `.gitignore`. */
  walletStorePath?: string
}

interface PerNodeState {
  /** Validator votes accumulated since the last submit-node-output.
   *  Submitted in one batch when the node hits subtask_validated /
   *  subtask_rejected. */
  votes: ValidatorVoteWire[]
}

interface PerTaskState {
  taskIdBytes32: string
  nodes: Map<string, PerNodeState>           // keyed by nodeId
  outputHashes: Map<string, string>          // keyed by nodeId
}

export class Spore {
  private readonly orchestrator: Orchestrator
  private readonly transport: SwarmTransport
  private readonly walletStore: WalletStore | null
  private readonly agentWallets = new Map<string, any>()
  private readonly registeredAgentIds = new Set<string>()
  private readonly perTask = new Map<string, PerTaskState>()
  private ethers: EthersModule | null = null

  constructor(opts: SporeManagedOptions) {
    if (!opts.apiKey) throw new Error('Spore: apiKey is required')

    this.orchestrator = new Orchestrator(opts)
    this.transport = new SwarmTransport({
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
    })
    this.walletStore = opts.walletStorePath ? new WalletStore(opts.walletStorePath) : null

    // Wire chain-mirror listeners. Orchestrator.emit() awaits handlers,
    // so each service round-trip completes before the local state
    // machine advances — sequential consistency for free.
    this.orchestrator.on('task_submitted', (e) => this.onTaskSubmitted(e))
    this.orchestrator.on('dag_ready', (e) => this.onDagReady(e))
    this.orchestrator.on('executor_done', (e) => this.onExecutorDone(e))
    this.orchestrator.on('validator_done', (e) => this.onValidatorDone(e))
    this.orchestrator.on('subtask_validated', (e) => this.onNodeResolved(e))
    this.orchestrator.on('subtask_rejected', (e) => this.onNodeResolved(e))
    this.orchestrator.on('task_completed', (e) => this.onTaskCompleted(e))
  }

  // ─── Registration / public API ──────────────────────────────────────

  /** Register agents into this Spore. Roles emerge dynamically per
   *  task (FCFS planner + workers, every agent participates in
   *  validation). Returns `this` so calls chain. */
  sporeise(...agents: SporeAgent[]): this {
    this.orchestrator.add(...agents)
    return this
  }

  /** Alias for `sporeise()`. */
  add(...agents: SporeAgent[]): this {
    return this.sporeise(...agents)
  }

  remove(agentId: string): boolean {
    return this.orchestrator.remove(agentId)
  }

  agents(): SporeAgent[] {
    return this.orchestrator.agents()
  }

  /** Snapshot of every agent's auto-generated wallet address. Empty
   *  before the first `run()` call — wallets are minted lazily. */
  walletAddresses(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const a of this.agents()) {
      const w = this.agentWallets.get(a.id)
      if (w) out[a.id] = w.address
    }
    return out
  }

  on<T extends SporeEventType>(type: T, handler: SporeEventHandler<T>): void
  on(type: '*', handler: (event: SporeEvent) => void | Promise<void>): void
  on(type: SporeEventType | '*', handler: (event: SporeEvent) => void | Promise<void>): void {
    this.orchestrator.on(type as any, handler as any)
  }

  off(type: SporeEventType | '*', handler: (event: SporeEvent) => void | Promise<void>): void {
    this.orchestrator.off(type, handler)
  }

  // ─── Run a task ─────────────────────────────────────────────────────

  async run(spec: string, opts: ExecuteOptions = {}): Promise<TaskResult & { taskIdBytes32: string }> {
    await this.ensureRegistered()
    const result = await this.orchestrator.execute(spec, opts)
    const chain = this.perTask.get(result.taskId)
    return {
      ...result,
      taskIdBytes32: chain?.taskIdBytes32 ?? '',
    }
  }

  // ─── Service-side registration ──────────────────────────────────────

  async registerAllAgents(): Promise<void> {
    const all = this.agents()
    const toRegister: RegisterAgentInput[] = []

    for (const agent of all) {
      if (this.registeredAgentIds.has(agent.id)) continue
      const wallet = await this.getOrCreateAgentWallet(agent.id)
      toRegister.push({ id: agent.id, walletAddress: wallet.address })
    }

    if (toRegister.length === 0) return
    await this.transport.registerAgents(toRegister)
    for (const a of toRegister) this.registeredAgentIds.add(a.id)
  }

  private async ensureRegistered(): Promise<void> {
    return this.registerAllAgents()
  }

  // ─── Per-event chain handlers ───────────────────────────────────────

  private async onTaskSubmitted(e: { taskId: string; spec: string; participants: string[] }): Promise<void> {
    const eth = await this.getEthers()

    // Orchestrator picks the planner from `plannerCursor` on the very
    // next line after task_submitted is emitted. Read the current value
    // to predict the same pick. Safe because Spore.run() runs
    // synchronously between events.
    const all = this.agents()
    const plannableAgents = all.filter((a) => typeof a.plan === 'function')
    const cursorVal = (this.orchestrator as unknown as { plannerCursor: number }).plannerCursor
    const planner = plannableAgents.length > 0
      ? plannableAgents[cursorVal % plannableAgents.length]!
      : all[0]!

    const taskIdBytes32 = eth.id(e.taskId)
    const specHash = eth.keccak256(eth.toUtf8Bytes(e.spec))
    const participantIds = e.participants.map((id) => eth.id(id))

    await this.transport.submitTask({
      taskIdBytes32,
      specHash,
      plannerId: eth.id(planner.id),
      participantIds,
    })

    this.perTask.set(e.taskId, {
      taskIdBytes32,
      nodes: new Map(),
      outputHashes: new Map(),
    })
  }

  private async onDagReady(e: { taskId: string; subtasks: string[] }): Promise<void> {
    const chain = this.perTask.get(e.taskId)
    if (!chain) return
    // The SDK only knows the orchestrator's flattened spec strings here,
    // but the service expects the full {id, spec, deps?} structure for
    // 0G Storage upload. Reconstruct minimal {id, spec} entries — DAG
    // semantics on chain only carry the dagHash anyway, so deps are
    // captured implicitly in the storage payload.
    const subtasks = e.subtasks.map((spec, i) => ({ id: `n${i + 1}`, spec }))
    await this.transport.registerDAG({
      taskIdBytes32: chain.taskIdBytes32,
      subtasks,
    })
  }

  private async onExecutorDone(e: {
    taskId: string
    nodeId: string
    workerId: string
    output: string
  }): Promise<void> {
    const chain = this.perTask.get(e.taskId)
    if (!chain) return
    const eth = await this.getEthers()
    const idx = this.nodeIdToIndex(e.nodeId)

    // Service uploads the raw output to 0G Storage and returns the root
    // hash that landed on-chain. Validators sign over THAT hash so the
    // contract can verify recovery against the registered wallet.
    const response = await this.transport.submitNodeOutput({
      taskIdBytes32: chain.taskIdBytes32,
      nodeIndex: idx,
      workerId: eth.id(e.workerId),
      output: e.output,
    })

    chain.outputHashes.set(e.nodeId, response.outputHash)
    chain.nodes.set(e.nodeId, { votes: [] })
  }

  private async onValidatorDone(e: {
    taskId: string
    nodeId: string
    validatorId: string
    verdict: ValidationVerdict
  }): Promise<void> {
    const chain = this.perTask.get(e.taskId)
    if (!chain) return
    const eth = await this.getEthers()
    const outputHashBytes32 = chain.outputHashes.get(e.nodeId)
    if (!outputHashBytes32) return

    const validatorIdBytes32 = eth.id(e.validatorId)
    const signature = await this.signValidatorVerdict(e.validatorId, {
      taskId: chain.taskIdBytes32,
      nodeId: e.nodeId,
      outputHash: outputHashBytes32,
      verdict: e.verdict,
    })

    let buf = chain.nodes.get(e.nodeId)
    if (!buf) {
      buf = { votes: [] }
      chain.nodes.set(e.nodeId, buf)
    }
    buf.votes.push({ agentId: validatorIdBytes32, valid: e.verdict.valid, signature })
  }

  private async onNodeResolved(e: { taskId: string; nodeId: string }): Promise<void> {
    const chain = this.perTask.get(e.taskId)
    if (!chain) return
    const buf = chain.nodes.get(e.nodeId)
    if (!buf || buf.votes.length === 0) return
    const idx = this.nodeIdToIndex(e.nodeId)
    await this.transport.submitValidations({
      taskIdBytes32: chain.taskIdBytes32,
      nodeIndex: idx,
      votes: buf.votes,
    })
    chain.nodes.set(e.nodeId, { votes: [] })
  }

  private async onTaskCompleted(e: { taskId: string }): Promise<void> {
    const chain = this.perTask.get(e.taskId)
    if (!chain) return
    await this.transport.completeTask({ taskIdBytes32: chain.taskIdBytes32 })
  }

  // ─── Wallet / signing ───────────────────────────────────────────────

  private async getOrCreateAgentWallet(agentId: string): Promise<any> {
    const cached = this.agentWallets.get(agentId)
    if (cached) return cached
    const eth = await this.getEthers()

    if (this.walletStore) {
      const stored = this.walletStore.get(agentId)
      if (stored) {
        const w = new eth.Wallet(stored.privateKey)
        this.agentWallets.set(agentId, w)
        return w
      }
    }

    const wallet = eth.Wallet.createRandom()
    if (this.walletStore) {
      this.walletStore.set(agentId, {
        address: wallet.address,
        privateKey: wallet.privateKey,
      })
    }
    this.agentWallets.set(agentId, wallet)
    return wallet
  }

  /**
   * Sign a validator verdict. Two paths:
   *   - agent.sign override (advanced — HSM, remote signer): payload
   *     forwarded as-is, the agent does its own encoding
   *   - SDK auto-wallet (default frictionless): build the contract's
   *     expected commitment (abi.encode of taskIdBytes32, nodeIndex,
   *     outputHashBytes32, valid, agentIdBytes32) and sign EIP-191
   *     over its keccak256
   */
  private async signValidatorVerdict(
    validatorId: string,
    payload: ValidationSignPayload,
  ): Promise<string> {
    const validator = this.findValidator(validatorId)
    if (validator?.sign) {
      return validator.sign(payload)
    }
    const wallet = await this.getOrCreateAgentWallet(validatorId)
    const eth = await this.getEthers()

    const taskIdBytes32 = payload.taskId  // already bytes32 (we stored it on perTask)
    const nodeIndex = this.nodeIdToIndex(payload.nodeId)
    const outputHashBytes32 = payload.outputHash
    const agentIdBytes32 = eth.id(validatorId)

    const encoded = eth.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'uint256', 'bytes32', 'bool', 'bytes32'],
      [taskIdBytes32, nodeIndex, outputHashBytes32, payload.verdict.valid, agentIdBytes32],
    )
    const raw: string = eth.solidityPackedKeccak256(['bytes'], [encoded])
    return wallet.signMessage(eth.getBytes(raw))
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  private findValidator(id: string): SporeAgent | undefined {
    return this.agents().find((a) => a.id === id)
  }

  private nodeIdToIndex(nodeId: string): number {
    // Accepts planner-supplied ids (n1, n2) AND legacy node-1 / node-2.
    const m = nodeId.match(/(\d+)\s*$/)
    if (!m) throw new Error(`Spore: cannot derive index from nodeId "${nodeId}"`)
    return Math.max(0, parseInt(m[1]!, 10) - 1)
  }

  private async getEthers(): Promise<EthersModule> {
    if (this.ethers) return this.ethers
    this.ethers = await import('ethers').catch(() => {
      throw new Error(
        'Spore: `ethers` is required (peer dep) for validator signing + hashing. ' +
          'Install with `pnpm add ethers`.',
      )
    })
    return this.ethers!
  }
}
