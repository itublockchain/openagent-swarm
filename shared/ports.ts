import { DAGNode, EventType, AXLEvent } from './types'

export interface IStoragePort {
  /** veriyi yazar, content hash döner */
  append(data: unknown): Promise<string>
  /** hash ile okur */
  fetch(hash: string): Promise<unknown>
  /**
   * Optimization for hot paths: compute the deterministic rootHash
   * locally and return it immediately, while the actual upload runs
   * in the background. Caller uses the hash on-chain right away;
   * peers reading via fetch() will retry until upload lands. Falls
   * back to append() shape on adapters that don't implement it.
   */
  appendDeferred?(data: unknown): Promise<{ rootHash: string; uploadPromise: Promise<void> }>
}

export interface IComputePort {
  /** spec'i DAG node listesine böler, max 3 node */
  buildDAG(spec: string): Promise<DAGNode[]>
  /** subtask'ı execute eder, çıktı string döner */
  complete(subtask: string, context: string | null): Promise<string>
  /** çıktıyı doğrular, false ise slash tetiklenir */
  judge(output: string): Promise<boolean>
  /**
   * Self-fitness check: given the agent's own systemPrompt and an incoming
   * subtask, return true iff the agent considers itself a good match. Used
   * by SwarmAgent before racing to claim, so a researcher-prompted agent
   * doesn't grab a code-generation node it'll fumble. Cheap one-token call.
   */
  assess(subtask: string, systemPrompt: string): Promise<boolean>
  /**
   * Low-level multi-turn chat. Optional — only adapters that wire it can
   * back the tool-aware agent loop (runAgentLoop). MockCompute echoes a
   * canned final-answer; ZGComputeAdapter forwards to the 0G provider.
   */
  chat?(messages: Array<{ role: string; content: string }>, maxTokens?: number): Promise<string>
}

export interface INetworkPort {
  emit<T>(event: AXLEvent<T>): Promise<void>
  on<T>(type: EventType | '*', handler: (event: AXLEvent<T>) => void | Promise<void>): void
  off<T>(type: EventType | '*', handler?: (event: AXLEvent<T>) => void | Promise<void>): void
}

export interface IChainPort {
  /** task için stake yatırır (planner kullanır), tx hash döner */
  stake(taskId: string, amount: string): Promise<string>
  /** Subtask seviyesinde stake kilidi (worker kullanır) */
  stakeForSubtask(taskId: string, nodeId: string, amount: string): Promise<string>
  /** FCFS — ilk çağıran true alır, sonrakiler false */
  claimPlanner(taskId: string): Promise<boolean>
  /** DAG'ı on-chain'e mühürler (sadece planner çağırabilir) */
  registerDAG(taskId: string, nodeIds: string[]): Promise<void>
  /** FCFS — nodeId bazlı, ilk çağıran true alır */
  claimSubtask(nodeId: string): Promise<boolean>
  /** subtask claim durumunu kontrol eder */
  isSubtaskClaimed(nodeId: string): Promise<boolean>
  /** subtask çıktısını on-chain'e kaydeder */
  submitOutput(nodeId: string, outputHash: string): Promise<void>
  /** Tüm node'ları tek tx'te validated işaretler, otomatik settle ETMEZ */
  markValidatedBatch(nodeIds: string[]): Promise<void>
  /** task'ın bittiğini kaydeder */
  completeTask(taskId: string): Promise<boolean>
  /** hatalı node'a itiraz açar; challengerNodeId challenger'ın kendi subtask'ı (planner ise '0x0') */
  challenge(nodeId: string, challengerNodeId?: string): Promise<void>
  /**
   * Commit-reveal phase 1 — juror sends sealed hash of their vote.
   * commitHash = keccak256(abi.encodePacked(nodeId, accusedGuilty, salt, msg.sender)).
   * Caller must already be in the on-chain eligibility list (random jury
   * picked at challenge() time); use isJuryEligible() before calling.
   */
  commitVoteOnChallenge(nodeId: string, commitHash: string): Promise<void>
  /**
   * Commit-reveal phase 2 — juror reveals their vote and salt; the contract
   * recomputes the hash and matches against the stored commit. Only callable
   * after commitDeadline and before revealDeadline.
   */
  revealVoteOnChallenge(nodeId: string, accusedGuilty: boolean, salt: string): Promise<void>
  /**
   * Returns true iff `address` was randomly selected as a juror for `nodeId`.
   * Off-chain agents call this right after the AXL CHALLENGE event and skip
   * the judge() round entirely if they aren't on the list — saves ~80% of
   * jury-side work in a 25-agent swarm with JURY_SIZE=5.
   */
  isJuryEligible(nodeId: string, address: string): Promise<boolean>
  /** Reveal penceresi dolduktan sonra çağrılır; revealed votes'a göre çözer */
  finalizeChallenge(nodeId: string): Promise<void>
  /** Explicit per-agent ödül dağıtımı (planner yetkili) */
  settleTask(taskId: string, winners: string[], amounts: string[]): Promise<void>
  /** Bir node'un on-chain claimant adresini döner */
  getNodeClaimant(nodeId: string): Promise<string>
  /** Task'ın budget'ını döner (smallest unit, decimals'a göre) */
  getTaskBudget(taskId: string): Promise<string>
  /**
   * True iff `tasks[taskId].finalized == true`. Used by the keeper-timeout
   * watchdog to short-circuit a forceComplete attempt when the planner
   * already settled (or another peer's forceComplete landed first).
   * Optional — the watchdog falls back to attempting forceComplete and
   * tolerating the "Task already finalized" revert when this isn't
   * implemented (e.g. mock adapter).
   */
  isTaskFinalized?(taskId: string): Promise<boolean>
  /**
   * Permissionless escape hatch for the "all nodes submitted but planner
   * never settled" failure mode. Reverts on-chain when the keeper still
   * has time, when the budget is empty, or when any node lacks an
   * outputHash. Caller (typically a non-planner agent watching the task)
   * doesn't supply winners/amounts — the contract reads them canonically
   * so a malicious bystander can't redirect the budget. See
   * `DAGRegistry.forceComplete` for the full state-machine notes.
   */
  forceComplete?(taskId: string): Promise<void>
  /** hatalı node'u sıfırlar */
  resetSubtask(nodeId: string): Promise<void>
  /**
   * How many `stakeAmount`-sized stakes the agent's wallet can still afford.
   * Used by SwarmAgent.claimFirstAvailable to cap greedy claims so a single
   * agent doesn't grab more nodes than it can actually stake for (which
   * otherwise reverts mid-DAG with ERC20InsufficientBalance and locks the
   * task). Optional — adapters that lack accounting (mock) may return
   * Number.MAX_SAFE_INTEGER. */
  getStakeCapacity?(stakeAmount: string): Promise<number>
  /** Returns this wallet's USDC balance in wei (smallest unit). Used by the
   *  surplus watchdog to detect rewards above stakeAmount and forward them
   *  back to the owner. Optional — Mock has no accounting. */
  getOwnUsdcBalance?(): Promise<string>
  /** Send USDC from this agent's wallet to `to`. amountWei is the smallest
   *  unit (e.g. 1 USDC at 18 decimals = "1000000000000000000"). Returns the
   *  tx hash. Optional — Mock no-ops. */
  transferUsdc?(to: string, amountWei: string): Promise<string>

  // Sync methods
  syncPlannerClaim(taskId: string, agentId: string): Promise<void>
  syncSubtaskClaim(nodeId: string, agentId: string): Promise<void>
  syncTaskCompletion(taskId: string, agentId: string): Promise<void>
}
