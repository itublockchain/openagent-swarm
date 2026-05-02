/**
 * Single agent contract for the Spore swarm.
 *
 * No role types at creation time — every agent is identical to the
 * orchestrator. Roles emerge dynamically per task:
 *
 *   - One agent is FCFS-elected as the PLANNER for the task. It runs
 *     `plan()` to decompose the spec into subtasks. Any agent that
 *     implements `plan` is eligible.
 *
 *   - For each subtask, an agent is FCFS-elected as the WORKER. It
 *     runs `execute()` to produce the deliverable.
 *
 *   - Every OTHER agent (i.e. everyone except the current worker) acts
 *     as a VALIDATOR for that subtask's output, running `judge()`. The
 *     orchestrator tallies a strict-majority verdict. Reject → retry
 *     the subtask on a different worker.
 *
 * `execute` is the only required method — every agent must be runnable.
 * `plan` / `judge` / `assess` are optional capabilities the orchestrator
 * uses when present. The `LangChainAgent` wrapper auto-derives all three
 * from the same LLM you wire into `execute` so a typical user just
 * passes `{ agent, llm }` and gets all four for free.
 */
export interface SporeAgent {
  /** Stable id used in events + on-chain registration. Auto-generated
   *  by the wrapper when omitted. */
  readonly id: string

  /** Free-form description of the agent's specialty. Drives the
   *  orchestrator's skill-filter when picking workers and the LLM-derived
   *  default `assess()`. Empty / undefined → generalist (claims anything). */
  readonly systemPrompt?: string

  /** Optional on-chain wallet override. When set, the SDK skips
   *  auto-minting a wallet for this agent and registers `walletAddress`
   *  with the SporeCoordinator instead. Must be paired with
   *  `signValidation` so the contract can recover signatures back to it. */
  readonly walletAddress?: string

  /** Required. Run the subtask, return the final answer string. */
  execute(input: AgentInput): Promise<string>

  /** Optional. Decompose the spec into 1..N subtask descriptions. An
   *  agent that implements `plan` is eligible to be elected planner.
   *  At least one agent in the swarm MUST implement this. */
  plan?(spec: string): Promise<string[]>

  /** Optional. Validate another agent's output (or, when called as the
   *  next worker, gate prev's output before consuming it as context).
   *  Default behaviour when omitted: trust everything. */
  judge?(input: JudgeInput): Promise<ValidationVerdict>

  /** Optional. Self-fitness probe before the orchestrator hands a
   *  subtask to this agent. Returning false makes the orchestrator
   *  pick a different agent. */
  assess?(subtask: string): Promise<boolean>

  /**
   * Optional override for the validator-vote signature. The default path
   * uses an SDK-managed auto-minted EOA per agent. Override to plug in
   * an HSM, remote signer, or hardware wallet. Must produce an EIP-191
   * `personal_sign` over the contract's expected payload hash.
   */
  signValidation?(payload: ValidationSignPayload): Promise<string>
}

export interface AgentInput {
  /** Planner-written subtask description. */
  subtask: string
  /** Final answer from the previous DAG node, or null for the first node. */
  context: string | null
  /** Stable id for the whole task. */
  taskId: string
  /** Stable id for this DAG node within the task (e.g. `node-1`). */
  nodeId: string
}

export interface JudgeInput {
  /** The subtask description the worker was given. */
  subtask: string
  /** The worker's output, ready to judge. */
  output: string
  /** Same task / node ids as the worker saw, for correlation. */
  taskId: string
  nodeId: string
  /** Worker that produced this output — useful when an agent's judge
   *  prompt incorporates "did the EXPECTED kind of agent run this?". */
  workerId: string
}

/**
 * What `judge` returns. `signature` is populated by the orchestrator
 * after the verdict is built (auto-mint wallet OR `signValidation`
 * override) — agents themselves never produce it.
 */
export interface ValidationVerdict {
  valid: boolean
  reason?: string
}

export interface ValidationSignPayload {
  /** bytes32 task id as the contract sees it. */
  taskIdBytes32: string
  nodeIndex: number
  /** bytes32 output hash from the worker's submission. */
  outputHashBytes32: string
  valid: boolean
  /** bytes32 agent id (the validator's id keccak'd). */
  agentIdBytes32: string
}
