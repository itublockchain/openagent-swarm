import { Indexer, MemData } from '@0gfoundation/0g-ts-sdk'
import { ethers } from 'ethers'
import { IStoragePort } from '../../../../shared/ports'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

const MAX_RETRIES = 3
const RETRY_BASE_MS = 2000

export class ZeroGStorage implements IStoragePort {
  private provider: ethers.JsonRpcProvider
  private signer: ethers.Wallet
  private indexer: Indexer
  private rpc: string

  constructor() {
    this.rpc = process.env.OG_RPC_URL ?? 'https://evmrpc-testnet.0g.ai'
    const indexerUrl = process.env.OG_INDEXER_URL ?? 'https://indexer-storage-testnet-standard.0g.ai'
    const pk = process.env.PRIVATE_KEY

    if (!pk) {
      throw new Error('[ZeroGStorage] PRIVATE_KEY env var is required for 0G Storage')
    }
    this.provider = new ethers.JsonRpcProvider(this.rpc)
    this.signer = new ethers.Wallet(pk, this.provider)
    this.indexer = new Indexer(indexerUrl)
  }

  private async withRetry<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn()
      } catch (err) {
        const isLast = attempt === MAX_RETRIES
        console.warn(`[ZeroGStorage] ${operation} attempt ${attempt}/${MAX_RETRIES} failed:`, err)
        if (isLast) throw err
        const delay = RETRY_BASE_MS * attempt
        await new Promise(r => setTimeout(r, delay))
      }
    }
    throw new Error(`[ZeroGStorage] ${operation} unreachable`)
  }

  async append(data: unknown): Promise<string> {
    return this.withRetry('append', async () => {
      const serialized = JSON.stringify(data)
      const buffer = Buffer.from(serialized, 'utf-8')

      const file = new MemData(buffer)

      const [tree, treeErr] = await file.merkleTree()
      if (treeErr || !tree) throw new Error(`Tree error: ${treeErr}`)

      const rootHash = tree.rootHash()!
      console.log(`[ZeroGStorage] uploading, root: ${rootHash}`)

      const [result, uploadErr] = await this.indexer.upload(
        file,
        this.rpc,
        this.signer
      )
      if (uploadErr || !result) throw new Error(`Upload error: ${uploadErr}`)

      const txHash = 'txHash' in result ? result.txHash : result.txHashes[0]
      console.log(`[ZeroGStorage] stored: ${rootHash}, tx: ${txHash}`)
      return rootHash
    })
  }

  async fetch(hash: string): Promise<unknown> {
    return this.withRetry('fetch', async () => {
      console.log(`[ZeroGStorage] fetching: ${hash}`)

      const tempDir = os.tmpdir()
      const tempFilePath = path.join(tempDir, `0g-download-${hash}-${Date.now()}.json`)

      try {
        const err = await this.indexer.download(
          hash,
          tempFilePath,
          true  // verify
        )
        if (err) throw new Error(`Download error: ${err}`)

        const text = fs.readFileSync(tempFilePath, 'utf-8')
        return JSON.parse(text)
      } finally {
        if (fs.existsSync(tempFilePath)) {
          fs.unlinkSync(tempFilePath)
        }
      }
    })
  }
}
