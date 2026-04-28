import { DAGNode, EventType, AXLEvent } from './types'

export interface IStoragePort {
  /** veriyi yazar, content hash döner */
  append(data: unknown): Promise<string>
  /** hash ile okur */
  fetch(hash: string): Promise<unknown>
}

export interface IComputePort {
  /** spec'i DAG node listesine böler, max 3 node */
  buildDAG(spec: string): Promise<DAGNode[]>
  /** subtask'ı execute eder, çıktı string döner */
  complete(subtask: string, context: string | null): Promise<string>
  /** çıktıyı doğrular, false ise slash tetiklenir */
  judge(output: string): Promise<boolean>
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
  /** node'u validated olarak işaretler, tüm DAG bitince settle tetiklenir */
  markValidated(nodeId: string): Promise<void>
  /** Tüm node'ları tek tx'te validated işaretler, otomatik settle ETMEZ */
  markValidatedBatch(nodeIds: string[]): Promise<void>
  /** task'ın bittiğini kaydeder */
  completeTask(taskId: string): Promise<boolean>
  /** hatalı node'a itiraz açar; challengerNodeId challenger'ın kendi subtask'ı (planner ise '0x0') */
  challenge(nodeId: string, challengerNodeId?: string): Promise<void>
  /** açık bir challenge'a jüri oyu kullanır. agentId çağıranın kendi AgentRegistry id'si */
  voteOnChallenge(nodeId: string, agentId: string, accusedGuilty: boolean): Promise<void>
  /** süresi dolan challenge'ı çoğunluğa göre kapatır (kimse oy vermediyse drop) */
  finalizeExpiredChallenge(nodeId: string): Promise<void>
  /** ödülleri dağıtır ve escrow'u kapatır */
  settle(taskId: string, winners: string[]): Promise<void>
  /** Explicit per-agent ödül dağıtımı (planner yetkili) */
  settleTask(taskId: string, winners: string[], amounts: string[]): Promise<void>
  /** Bir node'un on-chain claimant adresini döner */
  getNodeClaimant(nodeId: string): Promise<string>
  /** Task'ın budget'ını döner (smallest unit, decimals'a göre) */
  getTaskBudget(taskId: string): Promise<string>
  /** hatalı node'u sıfırlar */
  resetSubtask(nodeId: string): Promise<void>

  // Sync methods
  syncPlannerClaim(taskId: string, agentId: string): Promise<void>
  syncSubtaskClaim(nodeId: string, agentId: string): Promise<void>
  syncTaskCompletion(taskId: string, agentId: string): Promise<void>
}
