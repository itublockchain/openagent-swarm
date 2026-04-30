import { ethers } from 'ethers'
import { createZGComputeNetworkBroker } from '@0glabs/0g-serving-broker'

/**
 * Central compute proxy that fronts a wallet pool against 0G Compute. For
 * the demo `pool` is a single wallet (the API's PRIVATE_KEY); for mainnet
 * it can be expanded to N wallets and round-robin'd across concurrent
 * task inferences without touching agents.
 *
 * Why this exists: each agent used to spin up its own broker + ledger
 * sub-account (3 OG minimum each, 3.5 OG gas prefund). With 3 agents that
 * was ~19 OG locked just to bring the swarm online. Pooling collapses
 * that to one ledger (3 OG) and per-agent gas drops to ~0.5 OG (only L2
 * stake / claim / submitOutput tx gas).
 *
 * Trade-off: provider rate-limit and inference quota are now shared. For
 * mainnet scale extend `pool` and round-robin in `chat()`.
 */

interface PoolWallet {
  address: string
  signer: ethers.Wallet
  broker: any
  providerAddress: string
  modelName: string
  ready: boolean
}

const DEFAULT_MODEL = process.env.ZG_COMPUTE_MODEL ?? 'qwen/qwen-2.5-7b-instruct'
const RPC_URL = process.env.ZG_COMPUTE_RPC_URL ?? 'https://evmrpc-testnet.0g.ai'
const INITIAL_FUND_OG = Number(process.env.ZG_COMPUTE_INITIAL_FUND ?? '3')

// Provider rate-limit handling. 0G TEE providers throttle aggressively;
// without coordination across agents, all 4-5 agents fire chat() at once
// when DAG_READY broadcasts and we eat several rounds of 429 in a row.
const MAX_CONCURRENT = 2
const BACKOFF_BASE_MS = 2_000   // 2s, 4s, 8s, 16s, 32s
const BACKOFF_CAP_MS = 60_000

export class CentralComputeProxy {
  private pool: PoolWallet[] = []
  private next = 0
  private setupPromise: Promise<void> | null = null

  // In-process semaphore. We don't need a heavy queue lib — Promise resolvers
  // chained behind a counter are enough for the small fan-out here.
  private inflight = 0
  private waitQueue: Array<() => void> = []

  private async acquireSlot(): Promise<void> {
    if (this.inflight < MAX_CONCURRENT) {
      this.inflight++
      return
    }
    return new Promise<void>((resolve) => {
      this.waitQueue.push(() => {
        this.inflight++
        resolve()
      })
    })
  }

  private releaseSlot(): void {
    this.inflight = Math.max(0, this.inflight - 1)
    const next = this.waitQueue.shift()
    if (next) next()
  }

  constructor(privateKeys: string[]) {
    if (!privateKeys.length) {
      throw new Error('[CentralComputeProxy] at least one private key required')
    }
    const provider = new ethers.JsonRpcProvider(RPC_URL)
    for (const pk of privateKeys) {
      const signer = new ethers.Wallet(pk, provider)
      this.pool.push({
        address: signer.address,
        signer,
        broker: null,
        providerAddress: '',
        modelName: DEFAULT_MODEL,
        ready: false,
      })
    }
    console.log(`[CentralComputeProxy] pool size=${this.pool.length}`)
  }

  /**
   * Lazily setup all pool wallets in parallel on the first chat call.
   * Crashes loud — if 0G Compute is unreachable at API boot, demos
   * should fail fast rather than silently fall through to errors mid-task.
   */
  private async ensureReady(): Promise<void> {
    if (!this.setupPromise) {
      this.setupPromise = Promise.all(this.pool.map((w) => this.setupWallet(w))).then(() => {})
    }
    return this.setupPromise
  }

  private async setupWallet(w: PoolWallet): Promise<void> {
    if (w.ready) return
    console.log(`[CentralComputeProxy] initializing broker for ${w.address}`)
    w.broker = await createZGComputeNetworkBroker(w.signer)

    try {
      await w.broker.ledger.getLedger()
      console.log(`[CentralComputeProxy] ledger exists for ${w.address}`)
    } catch {
      console.log(`[CentralComputeProxy] creating ledger for ${w.address} (${INITIAL_FUND_OG} OG)`)
      try {
        await w.broker.ledger.addLedger(INITIAL_FUND_OG)
      } catch (err: any) {
        const msg = String(err?.message ?? err)
        if (/already|exist/i.test(msg)) {
          console.log(`[CentralComputeProxy] ledger already exists (race) for ${w.address}`)
        } else {
          throw new Error(`[CentralComputeProxy] addLedger failed for ${w.address}: ${msg}`)
        }
      }
    }

    const services = await w.broker.inference.listService()
    if (!services?.length) {
      throw new Error('[CentralComputeProxy] no inference providers available on 0G Compute')
    }
    const readField = (p: any, name: string, idx: number): string => {
      const v = p?.[name] ?? p?.[idx]
      return typeof v === 'string' ? v : ''
    }
    const target =
      services.find((s: any) => readField(s, 'model', 6) === DEFAULT_MODEL) ?? services[0]
    w.providerAddress = readField(target, 'provider', 0)
    w.modelName = readField(target, 'model', 6) || DEFAULT_MODEL
    if (!w.providerAddress || !ethers.isAddress(w.providerAddress)) {
      throw new Error(`[CentralComputeProxy] bad provider address for ${w.address}`)
    }
    console.log(`[CentralComputeProxy] selected provider ${w.providerAddress} model=${w.modelName}`)

    try {
      await w.broker.inference.acknowledgeProviderSigner(w.providerAddress)
    } catch (err: any) {
      const msg = String(err?.message ?? err)
      if (!/already|exist/i.test(msg)) {
        throw new Error(`[CentralComputeProxy] acknowledgeProviderSigner failed: ${msg}`)
      }
    }

    try {
      await w.broker.inference.startAutoFunding(w.providerAddress, {
        interval: 30_000,
        bufferMultiplier: 2,
      })
    } catch (err) {
      console.warn(`[CentralComputeProxy] startAutoFunding failed (non-fatal):`, err)
    }

    w.ready = true
  }

  private pick(): PoolWallet {
    const w = this.pool[this.next % this.pool.length]
    this.next++
    return w
  }

  /**
   * Forward a chat completion to one of the pool wallets. Round-robin
   * picks across the pool; for a single-wallet pool every call lands on
   * the same broker, which is fine for the demo.
   */
  async chat(messages: Array<{ role: string; content: string }>, maxTokens = 1024, temperature = 0.3): Promise<string> {
    await this.ensureReady()
    await this.acquireSlot()
    try {
      return await this.chatInner(messages, maxTokens, temperature)
    } finally {
      this.releaseSlot()
    }
  }

  private async chatInner(
    messages: Array<{ role: string; content: string }>,
    maxTokens: number,
    temperature: number,
  ): Promise<string> {
    const w = this.pick()
    const content = messages.map((m) => m.content).join('\n')
    const { endpoint, model } = await w.broker.inference.getServiceMetadata(w.providerAddress)

    const MAX_RETRIES = 5
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const headers = await w.broker.inference.getRequestHeaders(w.providerAddress, content)

      const res = await fetch(`${endpoint}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
      })

      if (res.status === 429) {
        // Exponential backoff: 2s, 4s, 8s, 16s, 32s (capped at 60s).
        const delay = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS)
        console.warn(`[CentralComputeProxy] 429 rate-limited, backing off ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`)
        await new Promise((r) => setTimeout(r, delay))
        continue
      }
      if (!res.ok) throw new Error(`0G Compute ${res.status}: ${await res.text()}`)

      const data = await res.json()
      const responseContent = data.choices[0].message.content
      const chatId = res.headers.get('ZG-Res-Key') || data.id
      const verified: boolean | null = await w.broker.inference.processResponse(
        w.providerAddress,
        chatId,
        content,
      )
      if (verified === false) {
        throw new Error(`[CentralComputeProxy] response signature verification failed (chatId=${chatId})`)
      }
      return responseContent
    }
    throw new Error('[CentralComputeProxy] max retries exceeded due to rate limiting')
  }
}
