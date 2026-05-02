/**
 * Deploys CCTPDepositReceiver to Base Sepolia and seeds the source-domain
 * allowlist for Ethereum Sepolia (domain 0) and Arbitrum Sepolia (domain 3).
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY=0x... npx hardhat run scripts/deploy-cctp-receiver.ts --network base_sepolia
 *
 * Inputs (env, with sane defaults for Circle's testnet deployment):
 *   BASE_USDC_ADDRESS                   defaults to Circle Base Sepolia USDC
 *   BASE_GATEWAY_ADDRESS                required — existing USDCGateway custody
 *   BASE_MESSAGE_TRANSMITTER_V2_ADDRESS defaults to Circle uniform V2 transmitter
 *   ETH_SEP_TOKEN_MESSENGER_V2          defaults to Circle uniform V2 token messenger
 *   ARB_SEP_TOKEN_MESSENGER_V2          defaults to Circle uniform V2 token messenger
 *
 * Output: extends contracts/deployments/base_sepolia.json with the receiver
 * address, deploy block, and per-domain allowlist for the BridgeWatcher
 * + chain.ts to load on boot.
 */
import { ethers } from 'hardhat'
import * as fs from 'fs'
import * as path from 'path'

// Circle's deployed addresses on V2 testnet — uniform across most chains.
// Pin defaults so a missing env var doesn't silently deploy with address(0).
const DEFAULT_BASE_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const DEFAULT_MESSAGE_TRANSMITTER_V2 = '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275'
const DEFAULT_TOKEN_MESSENGER_V2 = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA'

const ETH_SEPOLIA_DOMAIN = 0
const ARB_SEPOLIA_DOMAIN = 3

function addressToBytes32(addr: string): string {
  if (!addr.startsWith('0x') || addr.length !== 42) throw new Error(`bad address ${addr}`)
  return '0x' + '0'.repeat(24) + addr.slice(2).toLowerCase()
}

async function main() {
  const [deployer] = await ethers.getSigners()
  console.log('Deployer:', deployer.address)

  const usdcAddress = process.env.BASE_USDC_ADDRESS || DEFAULT_BASE_USDC

  // Existing gateway must already be deployed — we pull from env or
  // base_sepolia.json so we never bind to a stale/unknown address.
  const deploymentsDir = path.join(__dirname, '../deployments')
  const deploymentsPath = path.join(deploymentsDir, 'base_sepolia.json')
  let existing: Record<string, unknown> = {}
  if (fs.existsSync(deploymentsPath)) {
    existing = JSON.parse(fs.readFileSync(deploymentsPath, 'utf-8'))
  }
  const gatewayAddress = process.env.BASE_GATEWAY_ADDRESS || (existing.USDCGateway as string)
  if (!gatewayAddress) {
    throw new Error('BASE_GATEWAY_ADDRESS missing and no USDCGateway in base_sepolia.json')
  }

  const messageTransmitter =
    process.env.BASE_MESSAGE_TRANSMITTER_V2_ADDRESS || DEFAULT_MESSAGE_TRANSMITTER_V2

  const ethSepTokenMessenger =
    process.env.ETH_SEP_TOKEN_MESSENGER_V2 || DEFAULT_TOKEN_MESSENGER_V2
  const arbSepTokenMessenger =
    process.env.ARB_SEP_TOKEN_MESSENGER_V2 || DEFAULT_TOKEN_MESSENGER_V2

  console.log('USDC token:', usdcAddress)
  console.log('USDCGateway (forward target):', gatewayAddress)
  console.log('MessageTransmitterV2:', messageTransmitter)
  console.log('Eth Sepolia TokenMessengerV2:', ethSepTokenMessenger)
  console.log('Arb Sepolia TokenMessengerV2:', arbSepTokenMessenger)

  const Factory = await ethers.getContractFactory('CCTPDepositReceiver')
  const receiver = await Factory.deploy(
    usdcAddress,
    gatewayAddress,
    messageTransmitter,
    deployer.address,
  )
  await receiver.waitForDeployment()
  const receiverAddress = await receiver.getAddress()
  const deployTx = receiver.deploymentTransaction()
  const deployReceipt = deployTx ? await deployTx.wait() : null
  const deployBlock = deployReceipt?.blockNumber ?? 0
  console.log('CCTPDepositReceiver:', receiverAddress, '(block', deployBlock + ')')

  // Seed the source-chain allowlist. Without these entries, every
  // CCTP receive reverts on `domain not allowlisted` — and the user's
  // burned USDC stays stuck in Circle's pipeline until a finalized
  // recovery, which is the worst possible demo failure mode.
  console.log('Seeding srcTokenMessenger allowlist...')
  const tx0 = await receiver.setSrcTokenMessenger(
    ETH_SEPOLIA_DOMAIN,
    addressToBytes32(ethSepTokenMessenger),
  )
  await tx0.wait()
  console.log(`  domain ${ETH_SEPOLIA_DOMAIN} (Eth Sepolia) -> ${ethSepTokenMessenger}`)

  const tx1 = await receiver.setSrcTokenMessenger(
    ARB_SEPOLIA_DOMAIN,
    addressToBytes32(arbSepTokenMessenger),
  )
  await tx1.wait()
  console.log(`  domain ${ARB_SEPOLIA_DOMAIN} (Arb Sepolia) -> ${arbSepTokenMessenger}`)

  const updated = {
    ...existing,
    USDCGateway: gatewayAddress,
    USDC: usdcAddress,
    CCTPDepositReceiver: receiverAddress,
    CCTPDepositReceiverDeployBlock: deployBlock,
    MessageTransmitterV2: messageTransmitter,
    srcTokenMessengers: {
      [ETH_SEPOLIA_DOMAIN]: ethSepTokenMessenger,
      [ARB_SEPOLIA_DOMAIN]: arbSepTokenMessenger,
    },
    network: 'base_sepolia',
    deployedAt: new Date().toISOString(),
  }

  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir)
  fs.writeFileSync(deploymentsPath, JSON.stringify(updated, null, 2))
  console.log('Saved to deployments/base_sepolia.json')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
