/**
 * Thin HTTP client for the SPORE service's swarm-coordination endpoints.
 *
 * Every method here is a wire-level wrapper around `POST /v1/swarm/*`
 * routes the SDK's managed `Spore` class hits during a task run. The
 * service authenticates the API key, signs + submits the corresponding
 * SporeCoordinator transaction with its operator wallet, and bills the
 * gas back to the user's pre-funded SwarmTreasury balance.
 *
 * The SDK never holds an operator key — that's the entire point of this
 * layer. Validators STILL sign their verdicts locally (auto-minted EOAs
 * inside the SDK) so the BFT property survives even if the service
 * operator is malicious.
 */

import { SporeAPIError } from './errors'
import type { FetchLike } from './transport'

export interface SwarmTransportOptions {
  apiKey: string
  baseUrl?: string
  /** Per-request timeout in ms. Default 60s — chain tx round-trips can
   *  spike on a busy testnet. */
  timeoutMs?: number
  /** Inject a custom fetch (tests, custom retry policies, …). */
  fetch?: FetchLike
}

export interface RegisterAgentInput {
  /** Agent id as the SDK uses it locally. The service hashes it
   *  (keccak256) before passing into SporeCoordinator. */
  id: string
  /** Auto-generated EOA address. Recovery target for validator
   *  signatures + label for reputation analytics. */
  walletAddress: string
}

export interface SubmitTaskInput {
  taskIdBytes32: string
  specHash: string
  /** keccak256 of the FCFS-elected planner's local agent id. */
  plannerId: string
  /** keccak256 of every agent participating in this task — the
   *  contract uses (participants \ {currentExecutor}) as the eligible
   *  voter pool per node, so EVERY non-worker agent can vote on the
   *  output. */
  participantIds: string[]
}

export interface RegisterDAGInput {
  taskIdBytes32: string
  /** Raw subtasks payload — service uploads it to 0G Storage and uses
   *  the returned root hash as `dagHash` on-chain. SDK doesn't compute
   *  the hash locally; the service is the source of truth. */
  subtasks: Array<{ id: string; spec: string; deps?: string[] }>
}

export interface RegisterDAGResponse extends TxResponse {
  /** 0G Storage root hash the service committed on-chain. */
  dagHash: string
}

export interface SubmitNodeOutputInput {
  taskIdBytes32: string
  nodeIndex: number
  /** keccak256 of the worker's local agent id. */
  workerId: string
  /** Raw output text. Service uploads to 0G Storage and uses the root
   *  hash as `outputHash` on-chain. The same hash is returned so the
   *  SDK's validators sign over it consistently. */
  output: string
}

export interface SubmitNodeOutputResponse extends TxResponse {
  /** 0G Storage root hash the service committed on-chain. Validators
   *  MUST sign over this value, not a locally-recomputed hash. */
  outputHash: string
}

export interface ValidatorVoteWire {
  agentId: string
  valid: boolean
  signature: string
}

export interface SubmitValidationsInput {
  taskIdBytes32: string
  nodeIndex: number
  votes: ValidatorVoteWire[]
}

export interface CompleteTaskInput {
  taskIdBytes32: string
}

export interface TxResponse {
  /** Hash of the chain transaction the service submitted. */
  txHash: string
}

export class SwarmTransport {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly timeoutMs: number
  private readonly fetchImpl: FetchLike

  constructor(opts: SwarmTransportOptions) {
    if (!opts.apiKey) throw new Error('SwarmTransport: apiKey is required')
    this.baseUrl = (opts.baseUrl ?? 'https://api.sporeprotocol.xyz').replace(/\/+$/, '')
    this.apiKey = opts.apiKey
    this.timeoutMs = opts.timeoutMs ?? 60_000
    this.fetchImpl =
      opts.fetch ??
      (typeof globalThis.fetch === 'function'
        ? globalThis.fetch.bind(globalThis)
        : (undefined as unknown as FetchLike))
    if (typeof this.fetchImpl !== 'function') {
      throw new Error(
        'SwarmTransport: no global fetch found. Pass a fetch implementation explicitly.',
      )
    }
  }

  // ─── Public methods ─────────────────────────────────────────────────

  async registerAgents(agents: RegisterAgentInput[]): Promise<{ registered: string[] }> {
    return this.post('/v1/swarm/register-agents', { agents })
  }

  async submitTask(input: SubmitTaskInput): Promise<TxResponse> {
    return this.post('/v1/swarm/submit-task', input)
  }

  async registerDAG(input: RegisterDAGInput): Promise<RegisterDAGResponse> {
    return this.post('/v1/swarm/register-dag', input)
  }

  async submitNodeOutput(input: SubmitNodeOutputInput): Promise<SubmitNodeOutputResponse> {
    return this.post('/v1/swarm/submit-node-output', input)
  }

  async submitValidations(input: SubmitValidationsInput): Promise<TxResponse> {
    return this.post('/v1/swarm/submit-validations', input)
  }

  async completeTask(input: CompleteTaskInput): Promise<TxResponse> {
    return this.post('/v1/swarm/complete-task', input)
  }

  // ─── Internals ──────────────────────────────────────────────────────

  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(new Error('Request timed out')), this.timeoutMs)
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
    } finally {
      clearTimeout(timer)
    }

    const text = await response.text()
    let parsed: unknown = null
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = text
      }
    }

    if (!response.ok) {
      const bodyObj = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
      throw new SporeAPIError({
        status: response.status,
        code: typeof bodyObj.code === 'string' ? bodyObj.code : undefined,
        message:
          typeof bodyObj.error === 'string'
            ? bodyObj.error
            : `POST ${path} failed with ${response.status}`,
        body: parsed,
        request: { method: 'POST', path },
      })
    }

    return parsed as T
  }
}
