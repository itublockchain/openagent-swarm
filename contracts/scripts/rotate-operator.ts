/**
 * One-shot owner-only operator rotation. Used when the API runs with a
 * different EOA than whatever signed the deploy txs — e.g. you deployed
 * with one key, then later changed root .env PRIVATE_KEY to another.
 * Symptom: BridgeWatcher logs `creditBalance failed … "not operator"`.
 *
 * Run with the OWNER key, NOT the API key:
 *
 *   OWNER_PRIVATE_KEY=0x… NEW_OPERATOR=0x7D4cc79C…34383 \
 *     npx hardhat run scripts/rotate-operator.ts --network og_testnet
 *
 *   OWNER_PRIVATE_KEY=0x… NEW_OPERATOR=0x7D4cc79C…34383 \
 *     npx hardhat run scripts/rotate-operator.ts --network base_sepolia
 *
 * The two networks point at different deployments; run the script once
 * per network. Idempotent — re-running with the same NEW_OPERATOR is a
 * no-op tx (still costs gas).
 */
import { ethers, network } from 'hardhat'
import * as fs from 'fs'
import * as path from 'path'

async function main() {
  const ownerPk = process.env.OWNER_PRIVATE_KEY
  const newOperator = process.env.NEW_OPERATOR
  if (!ownerPk) throw new Error('OWNER_PRIVATE_KEY env var is required')
  if (!newOperator || !/^0x[0-9a-fA-F]{40}$/.test(newOperator)) {
    throw new Error('NEW_OPERATOR env var must be a 0x-prefixed 20-byte address')
  }

  const provider = ethers.provider
  const ownerWallet = new ethers.Wallet(ownerPk, provider)
  console.log(`Network: ${network.name}`)
  console.log(`Owner signer: ${ownerWallet.address}`)
  console.log(`New operator: ${newOperator}`)

  if (network.name === 'og_testnet') {
    const dep = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../deployments/og_testnet.json'), 'utf-8'),
    )
    await rotate({
      label: 'SwarmTreasury',
      address: dep.SwarmTreasury,
      abiPath: '../artifacts/src/SwarmTreasury.sol/SwarmTreasury.json',
      ownerWallet,
      newOperator,
    })
  } else if (network.name === 'base_sepolia') {
    const dep = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../deployments/base_sepolia.json'), 'utf-8'),
    )
    await rotate({
      label: 'USDCGateway',
      address: dep.USDCGateway,
      abiPath: '../artifacts/src/USDCGateway.sol/USDCGateway.json',
      ownerWallet,
      newOperator,
    })
  } else {
    throw new Error(`Unsupported network: ${network.name}`)
  }
}

async function rotate(args: {
  label: string
  address: string
  abiPath: string
  ownerWallet: any
  newOperator: string
}) {
  const abi = JSON.parse(fs.readFileSync(path.join(__dirname, args.abiPath), 'utf-8')).abi
  const contract = new ethers.Contract(args.address, abi, args.ownerWallet)

  const currentOwner: string = await contract.owner()
  const currentOperator: string = await contract.operator()
  console.log(`${args.label} @ ${args.address}`)
  console.log(`  current owner:    ${currentOwner}`)
  console.log(`  current operator: ${currentOperator}`)

  if (currentOwner.toLowerCase() !== args.ownerWallet.address.toLowerCase()) {
    throw new Error(
      `Signer is not owner of ${args.label}. Owner is ${currentOwner}, signer is ${args.ownerWallet.address}.`,
    )
  }

  if (currentOperator.toLowerCase() === args.newOperator.toLowerCase()) {
    console.log(`  already correct — skipping setOperator`)
    return
  }

  const tx = await contract.setOperator(args.newOperator)
  console.log(`  setOperator tx: ${tx.hash}`)
  const receipt = await tx.wait()
  console.log(`  mined in block ${receipt?.blockNumber}; new operator = ${args.newOperator}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
