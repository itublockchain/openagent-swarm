/**
 * Orchestrator — local in-memory state machine that drives a swarm of
 * homogeneous agents through one task at a time. Roles emerge per task:
 *
 *   - PLANNER : FCFS-elected from the agents that implement `plan`.
 *               Decomposes the spec into a DAG of subtasks (each with
 *               an id + spec + optional `deps`).
 *   - WORKER  : FCFS-elected per ready subtask from the agents that
 *               implement `execute`.
 *   - VALIDATOR : every OTHER agent (= all minus current worker) that
 *               implements `validate` runs on every output. Strict
 *               majority decides; reject → retry on different worker.
 *
 * DAG execution: subtasks with all deps satisfied run in PARALLEL on
 * different workers. Sequential default — when a subtask omits `deps`,
 * the orchestrator inserts an implicit dep on the previous subtask in
 * declaration order, preserving the linear-chain behaviour for planners
 * that don't think about parallelism.
 */

import { type AgentInput, type SporeAgent, type ValidationVerdict } from './agent'
import { type DAGSubtask, type ExecuteResult, type PlanResult } from './langchain'
import {
  type SporeEvent,
  type SporeEventHandler,
  type SporeEventOf,
  type SporeEventType,
} from './events'

// ─── Public types ───────────────────────────────────────────────────────

export interface SporeOptions {
  /** Max times a single subtask can be re-run on different workers
   *  after a validator-majority rejection. Default 1. */
  maxRetries?: number
  /** Logger sink. Default: silent. Pass `console` to mirror events. */
  logger?: { info(msg: string, ...args: unknown[]): void; error(msg: string, ...args: unknown[]): void }
}

export interface ExecuteOptions {
  /** Override Spore-level maxRetries for this run. */
  maxRetries?: number
  /** Caller AbortSignal. */
  signal?: AbortSignal
}

export interface NodeResult {
  nodeId: string
  spec: string
  output: string
  workerId: string
  verdicts: Array<{ validatorId: string; verdict: ValidationVerdict }>
  /** How many worker attempts this node took (1 = first try). */
  attempts: number
  /** Inputs this node consumed — keyed by upstream nodeId. Empty for
   *  source nodes (no deps). */
  context: Record<string, string>
}

export interface TaskResult {
  taskId: string
  spec: string
  /** Final answer = the LAST subtask's output (planner is responsible
   *  for ordering — last node is the deliverable). */
  result: string
  plannerId: string
  participants: string[]
  subtasks: DAGSubtask[]
  nodes: NodeResult[]
  events: SporeEvent[]
}

// ─── Orchestrator class ────────────────────────────────────────────────

export class Orchestrator {
  private readonly _agents: SporeAgent[] = []
  private readonly listeners = new Map<SporeEventType | '*', Set<(e: SporeEvent) => void | Promise<void>>>()
  private readonly opts: Required<Omit<SporeOptions, 'logger'>> & Pick<SporeOptions, 'logger'>
  private taskCounter = 0
  /** Round-robin cursors. Tracked separately so the planner pick
   *  rotates per task and the worker pick rotates per node. */
  private plannerCursor = 0
  private workerCursor = 0

  constructor(opts: SporeOptions = {}) {
    this.opts = {
      maxRetries: opts.maxRetries ?? 1,
      logger: opts.logger,
    }
  }

  // ─── Registration ─────────────────────────────────────────────────────

  add(...agents: SporeAgent[]): this {
    for (const a of agents) {
      if (this._agents.find((x) => x.id === a.id)) {
        throw new Error(`Orchestrator.add: agent id "${a.id}" already registered`)
      }
      this._agents.push(a)
      this.log(`add agent "${a.id}"`)
    }
    return this
  }

  remove(agentId: string): boolean {
    const idx = this._agents.findIndex((a) => a.id === agentId)
    if (idx === -1) return false
    this._agents.splice(idx, 1)
    return true
  }

  agents(): SporeAgent[] {
    return [...this._agents]
  }

  // ─── Event surface ────────────────────────────────────────────────────

  on<T extends SporeEventType>(type: T, handler: SporeEventHandler<T>): void
  on(type: '*', handler: (event: SporeEvent) => void | Promise<void>): void
  on(type: SporeEventType | '*', handler: (event: SporeEvent) => void | Promise<void>): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(handler)
  }

  off(type: SporeEventType | '*', handler: (event: SporeEvent) => void | Promise<void>): void {
    this.listeners.get(type)?.delete(handler)
  }

  private async emit<T extends SporeEvent>(event: T): Promise<void> {
    const typed = this.listeners.get(event.type)
    const wild = this.listeners.get('*')
    const all: Array<(e: SporeEvent) => void | Promise<void>> = []
    if (typed) for (const h of typed) all.push(h)
    if (wild) for (const h of wild) all.push(h)
    await Promise.all(
      all.map(async (h) => {
        try {
          await h(event)
        } catch (err) {
          this.error('listener threw:', err)
        }
      }),
    )
  }

  // ─── Execute one task ────────────────────────────────────────────────

  async execute(spec: string, opts: ExecuteOptions = {}): Promise<TaskResult> {
    if (this._agents.length < 2) {
      throw new Error(
        `Orchestrator.execute: need at least 2 agents (1 planner + 1 worker). ` +
          `Currently registered: ${this._agents.length}.`,
      )
    }

    const taskId = `task-${++this.taskCounter}-${Date.now().toString(36)}`
    const events: SporeEvent[] = []
    const tap = (e: SporeEvent) => { events.push(e) }
    this.on('*', tap)

    const maxRetries = opts.maxRetries ?? this.opts.maxRetries
    const participants = this._agents.map((a) => a.id)

    try {
      await this.checkAborted(opts.signal)
      await this.emit({ type: 'task_submitted', taskId, spec, participants, timestamp: Date.now() })

      // ─── 1. ELECT PLANNER (FCFS over agents that have plan) ──────
      const planner = this.electPlanner()
      if (!planner) {
        const reason = 'no agent in the swarm implements plan() — at least one is required'
        await this.emitTaskFailed(taskId, 'electing_planner', reason)
        throw new Error(`Orchestrator.execute: ${reason}`)
      }
      await this.emit({ type: 'planner_elected', taskId, plannerId: planner.id, timestamp: Date.now() })

      // ─── 2. PLAN ──────────────────────────────────────────────────
      let planResult: PlanResult
      try {
        planResult = await planner.plan!({ spec })
      } catch (err) {
        await this.emitTaskFailed(taskId, 'planning', `planner threw: ${(err as Error).message}`)
        throw err
      }
      const subtasks = this.normaliseDeps(planResult?.subtasks ?? [])
      if (subtasks.length === 0) {
        const reason = 'planner returned empty subtask list'
        await this.emitTaskFailed(taskId, 'planning', reason)
        throw new Error(`Orchestrator.execute: ${reason}`)
      }
      // Surface the FLATTENED subtask spec list on dag_ready for
      // back-compat with consumers that expect strings.
      await this.emit({
        type: 'dag_ready',
        taskId,
        plannerId: planner.id,
        subtasks: subtasks.map((s) => s.spec),
        timestamp: Date.now(),
      })

      // ─── 3. TOPOLOGICAL EXECUTION ────────────────────────────────
      // Subtasks with all deps satisfied run in PARALLEL on different
      // workers. After each batch completes, recompute the ready set
      // and run the next batch. Each node carries its own "context"
      // (map of upstream nodeId → output) into execute / validate.
      const completed = new Map<string, NodeResult>()  // id → result
      const pending = new Set(subtasks.map((s) => s.id))

      while (pending.size > 0) {
        const ready = subtasks.filter(
          (s) => pending.has(s.id) && (s.deps ?? []).every((d) => completed.has(d)),
        )
        if (ready.length === 0) {
          const reason = `cyclic deps or unsatisfiable DAG — pending=${[...pending].join(',')}`
          await this.emitTaskFailed(taskId, 'planning', reason)
          throw new Error(`Orchestrator.execute: ${reason}`)
        }

        // Run ready batch in parallel.
        const runs = await Promise.all(
          ready.map((node) => this.runNode({ taskId, node, completed, maxRetries, signal: opts.signal })),
        )
        for (const r of runs) {
          completed.set(r.nodeId, r)
          pending.delete(r.nodeId)
        }
      }

      // ─── 4. COMPLETE ─────────────────────────────────────────────
      // Final answer = the LAST subtask's output. Planner is
      // responsible for ordering its DAG so the deliverable is last.
      const finalNode = completed.get(subtasks[subtasks.length - 1]!.id)!
      await this.emit({
        type: 'task_completed',
        taskId,
        result: finalNode.output,
        timestamp: Date.now(),
      })

      // Preserve declaration order in the returned `nodes` array.
      const nodes = subtasks.map((s) => completed.get(s.id)!)
      return {
        taskId,
        spec,
        result: finalNode.output,
        plannerId: planner.id,
        participants,
        subtasks,
        nodes,
        events,
      }
    } finally {
      this.off('*', tap)
    }
  }

  // ─── Per-node execution + retry-on-reject ────────────────────────────

  private async runNode(args: {
    taskId: string
    node: DAGSubtask
    completed: Map<string, NodeResult>
    maxRetries: number
    signal?: AbortSignal
  }): Promise<NodeResult> {
    const { taskId, node, completed, maxRetries } = args
    const triedWorkers = new Set<string>()

    // Build the context payload from this node's deps.
    const context: Record<string, string> = {}
    for (const depId of node.deps ?? []) {
      const dep = completed.get(depId)
      if (dep) context[depId] = dep.output
    }
    // For execute(), pass either a single string (most common case —
    // one upstream dep) or the full record so the worker can address
    // each input by name.
    const contextForExecute =
      Object.keys(context).length === 1
        ? Object.values(context)[0]!
        : Object.keys(context).length > 1
          ? context
          : null

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      await this.checkAborted(args.signal)
      const worker = await this.electWorker(triedWorkers)
      if (!worker) {
        const reason =
          triedWorkers.size > 0
            ? `no alternate worker available for retry on ${node.id}`
            : `no eligible worker for ${node.id}`
        await this.emitTaskFailed(taskId, 'electing_worker', reason)
        throw new Error(`Orchestrator.execute: ${reason}`)
      }
      triedWorkers.add(worker.id)

      await this.emit({
        type: 'subtask_started',
        taskId,
        nodeId: node.id,
        index: 0,  // index is ambiguous in a parallel DAG; preserved for back-compat
        subtask: node.spec,
        workerId: worker.id,
        attempt,
        timestamp: Date.now(),
      })

      let execResult: ExecuteResult
      try {
        execResult = await worker.execute!({ spec: node.spec, context: contextForExecute })
      } catch (err) {
        const errVerdict = {
          validatorId: '<worker-error>',
          verdict: { valid: false, reason: (err as Error).message, confidence: 1 },
        }
        await this.emit({
          type: 'subtask_rejected',
          taskId,
          nodeId: node.id,
          verdicts: [errVerdict],
          willRetry: attempt < maxRetries,
          timestamp: Date.now(),
        })
        if (attempt >= maxRetries) {
          await this.emitTaskFailed(taskId, 'executing', `worker threw on final attempt: ${(err as Error).message}`)
          throw err
        }
        continue
      }

      const output = execResult.output
      await this.emit({
        type: 'executor_done',
        taskId,
        nodeId: node.id,
        workerId: worker.id,
        output,
        timestamp: Date.now(),
      })

      // Every OTHER agent (with a validate method) judges the output.
      const verdicts = await this.runValidators(taskId, node, output, worker.id, contextForExecute)
      const passed = this.tally(verdicts)

      if (passed) {
        const consensus =
          verdicts.length === 1
            ? 'single'
            : verdicts.every((v) => v.verdict.valid)
              ? 'unanimous'
              : 'majority'
        await this.emit({
          type: 'subtask_validated',
          taskId,
          nodeId: node.id,
          verdicts,
          consensus,
          timestamp: Date.now(),
        })
        return {
          nodeId: node.id,
          spec: node.spec,
          output,
          workerId: worker.id,
          verdicts,
          attempts: attempt + 1,
          context,
        }
      }

      await this.emit({
        type: 'subtask_rejected',
        taskId,
        nodeId: node.id,
        verdicts,
        willRetry: attempt < maxRetries,
        timestamp: Date.now(),
      })
      if (attempt >= maxRetries) {
        const reason = `node ${node.id} rejected by validator majority after ${attempt + 1} attempt(s)`
        await this.emitTaskFailed(taskId, 'validating', reason)
        throw new Error(`Orchestrator.execute: ${reason}`)
      }
    }

    throw new Error('Orchestrator.execute: unreachable')
  }

  // ─── Pickers ────────────────────────────────────────────────────────

  private electPlanner(): SporeAgent | null {
    const n = this._agents.length
    for (let i = 0; i < n; i++) {
      const idx = (this.plannerCursor + i) % n
      const cand = this._agents[idx]!
      if (typeof cand.plan === 'function') {
        this.plannerCursor = (idx + 1) % n
        return cand
      }
    }
    return null
  }

  private async electWorker(exclude: Set<string>): Promise<SporeAgent | null> {
    const n = this._agents.length
    for (let i = 0; i < n; i++) {
      const idx = (this.workerCursor + i) % n
      const cand = this._agents[idx]!
      if (exclude.has(cand.id)) continue
      if (typeof cand.execute !== 'function') continue
      this.workerCursor = (idx + 1) % n
      return cand
    }
    return null
  }

  /** All agents EXCEPT the current worker that implement validate run
   *  in parallel. With N agents → N-1 votes per node. */
  private async runValidators(
    taskId: string,
    node: DAGSubtask,
    output: string,
    workerId: string,
    contextForJudge: unknown,
  ): Promise<Array<{ validatorId: string; verdict: ValidationVerdict }>> {
    const validators = this._agents.filter(
      (a) => a.id !== workerId && typeof a.validate === 'function',
    )
    if (validators.length === 0) {
      return [{
        validatorId: '<no-validators>',
        verdict: { valid: true, reason: 'no validator pool', confidence: 0 },
      }]
    }
    return Promise.all(
      validators.map(async (v) => {
        let verdict: ValidationVerdict
        try {
          verdict = await v.validate!({ spec: node.spec, output, context: contextForJudge })
        } catch (err) {
          verdict = { valid: false, reason: `validate threw: ${(err as Error).message}`, confidence: 1 }
        }
        await this.emit({
          type: 'validator_done',
          taskId,
          nodeId: node.id,
          validatorId: v.id,
          verdict,
          timestamp: Date.now(),
        })
        return { validatorId: v.id, verdict }
      }),
    )
  }

  /** Strict majority of `valid:true`. Even split rejects. Confidence is
   *  surfaced to consumers but doesn't weight the tally yet — the
   *  constant-weight rule keeps Phase 1 predictable; weighted voting
   *  lands in Phase 3. */
  private tally(verdicts: Array<{ verdict: ValidationVerdict }>): boolean {
    const valid = verdicts.filter((v) => v.verdict.valid).length
    return valid * 2 > verdicts.length
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  /** When the planner omits `deps` for some nodes, default to "depends
   *  on the previous node in declaration order". This preserves the
   *  linear-chain behaviour planners often emit without forcing them
   *  to wire deps explicitly. Empty `deps: []` stays empty (signals
   *  "no deps, run in parallel"). */
  private normaliseDeps(subtasks: DAGSubtask[]): DAGSubtask[] {
    return subtasks.map((s, i) => {
      if (s.deps !== undefined) return s
      if (i === 0) return { ...s, deps: [] }
      return { ...s, deps: [subtasks[i - 1]!.id] }
    })
  }

  private async checkAborted(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw signal.reason ?? new Error('aborted')
    }
  }

  private async emitTaskFailed(taskId: string, phase: string, reason: string): Promise<void> {
    await this.emit({ type: 'task_failed', taskId, phase, reason, timestamp: Date.now() })
  }

  private log(msg: string, ...args: unknown[]): void {
    this.opts.logger?.info(`[Orchestrator] ${msg}`, ...args)
  }
  private error(msg: string, ...args: unknown[]): void {
    this.opts.logger?.error(`[Orchestrator] ${msg}`, ...args)
  }
}

export type { SporeEventOf }
