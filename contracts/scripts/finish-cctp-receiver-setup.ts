/**
 * Finishes the CCTPDepositReceiver allowlist seeding when the initial
 * deploy script crashed mid-loop (nonce race), and persists the deployment
 * info to base_sepolia.json. Idempotent: safe to re-run.
 */
import { ethers } from 'hardhat'
import * as fs from 'fs'
import * as path from 'path'

const RECEIVER = '0xfa857ccf17b39804073F138f4Ce6c83ae6BDc1FD'
const RECEIVER_DEPLOY_BLOCK = 40970990
const MESSAGE_TRANSMITTER = '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275'
const TOKEN_MESSENGER = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA'
const ETH_SEP_DOMAIN = 0
const ARB_SEP_DOMAIN = 3

function addressToBytes32(addr: string): string {
  return '0x' + '0'.repeat(24) + addr.slice(2).toLowerCase()
}

async function main() {
  const [deployer] = await ethers.getSigners()
  console.log('Operator:', deployer.address)

  const receiver = await ethers.getContractAt('CCTPDepositReceiver', RECEIVER, deployer)

  const expected = addressToBytes32(TOKEN_MESSENGER)

  for (const [domain, label] of [[ETH_SEP_DOMAIN, 'Eth Sepolia'], [ARB_SEP_DOMAIN, 'Arb Sepolia']] as const) {
    const current = await receiver.srcTokenMessenger(domain)
    if (current.toLowerCase() === expected.toLowerCase()) {
      console.log(`  domain ${domain} (${label}) already set`)
      continue
    }
    console.log(`  domain ${domain} (${label}) setting...`)
    const tx = await receiver.setSrcTokenMessenger(domain, expected, { nonce: undefined })
    await tx.wait()
    console.log(`    -> ${expected}`)
  }

  const deploymentsPath = path.join(__dirname, '../deployments/base_sepolia.json')
  const existing = JSON.parse(fs.readFileSync(deploymentsPath, 'utf-8'))
  const updated = {
    ...existing,
    CCTPDepositReceiver: RECEIVER,
    CCTPDepositReceiverDeployBlock: RECEIVER_DEPLOY_BLOCK,
    MessageTransmitterV2: MESSAGE_TRANSMITTER,
    srcTokenMessengers: {
      [ETH_SEP_DOMAIN]: TOKEN_MESSENGER,
      [ARB_SEP_DOMAIN]: TOKEN_MESSENGER,
    },
    deployedAt: new Date().toISOString(),
  }
  fs.writeFileSync(deploymentsPath, JSON.stringify(updated, null, 2))
  console.log('Updated', deploymentsPath)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
