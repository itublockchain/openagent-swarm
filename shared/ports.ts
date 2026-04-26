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
  /** task için stake yatırır, tx hash döner */
  stake(taskId: string, amount: string): Promise<string>
  /** FCFS — ilk çağıran true alır, sonrakiler false */
  claimPlanner(taskId: string): Promise<boolean>
  /** FCFS — nodeId bazlı, ilk çağıran true alır */
  claimSubtask(nodeId: string): Promise<boolean>
  /** hatalı node'a itiraz açar */
  challenge(nodeId: string): Promise<void>
  /** ödülleri dağıtır ve escrow'u kapatır */
  settle(taskId: string, winners: string[]): Promise<void>
  /** hatalı node'u sıfırlar */
  resetSubtask(nodeId: string): Promise<void>
}
