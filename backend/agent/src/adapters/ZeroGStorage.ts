import { Indexer, MemData } from '@0glabs/0g-ts-sdk'
import { ethers } from 'ethers'
import { IStoragePort } from '../../../../shared/ports'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

const OG_RPC = process.env.OG_RPC_URL ?? 'https://evmrpc-testnet.0g.ai'
const OG_INDEXER = process.env.OG_INDEXER_URL ?? 'https://indexer-storage-testnet-standard.0g.ai'
const PRIVATE_KEY = process.env.PRIVATE_KEY!

export class ZeroGStorage implements IStoragePort {
  private provider: ethers.JsonRpcProvider
  private signer: ethers.Wallet
  private indexer: Indexer

  constructor() {
    this.provider = new ethers.JsonRpcProvider(OG_RPC)
    this.signer = new ethers.Wallet(PRIVATE_KEY, this.provider)
    this.indexer = new Indexer(OG_INDEXER)
  }

  async append(data: unknown): Promise<string> {
    const serialized = JSON.stringify(data)
    const buffer = Buffer.from(serialized, 'utf-8')

    // Use MemData for in-memory buffer
    const file = new MemData(buffer)

    // Merkle root = content hash
    const [tree, treeErr] = await file.merkleTree()
    if (treeErr || !tree) throw new Error(`Tree error: ${treeErr}`)

    const rootHash = tree.rootHash()!
    console.log(`[ZeroGStorage] uploading, root: ${rootHash}`)

    // Upload
    const [result, uploadErr] = await this.indexer.upload(
      file,
      OG_RPC,
      this.signer
    )
    if (uploadErr || !result) throw new Error(`Upload error: ${uploadErr}`)

    console.log(`[ZeroGStorage] stored: ${rootHash}, tx: ${result.txHash}`)
    return rootHash
  }

  async fetch(hash: string): Promise<unknown> {
    console.log(`[ZeroGStorage] fetching: ${hash}`)

    // Create a temporary file for download
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
      // Cleanup
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath)
      }
    }
  }
}
