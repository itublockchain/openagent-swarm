/**
 * One-shot deploy of a dedicated SwarmTreasury instance for sporeise
 * gas debits. Owner + operator are set to msg.sender (the deployer key,
 * which should be the same EOA the API uses as PRIVATE_KEY).
 *
 *   DEPLOYER_PRIVATE_KEY=<your operator key> \
 *     npx hardhat run scripts/deploy-sporeise-gas-treasury.ts --network og_testnet
 *
 * Why a separate deploy:
 *   - The legacy SwarmTreasury at the address recorded in
 *     `deployments/og_testnet.json` was deployed under a different
 *     owner key. Its `operator()` doesn't match our PRIVATE_KEY, so
 *     `Treasury.debitBalance` reverts "not operator" — sporeise gas
 *     debits silently no-op.
 *   - We can't rotate the legacy operator without that owner key.
 *   - Easiest fix: deploy a fresh Treasury we DO own + operate. Wire
 *     it into the API runtime via L2_SPORE_GAS_TREASURY_ADDRESS env
 *     so `gasMeter` targets it.
 *
 * What this contract does NOT do:
 *   - It is NOT linked to SwarmEscrow's `setTreasury(...)` (one-shot,
 *     already pointed at the legacy Treasury). Classic `/task`
 *     submission still runs through the legacy Treasury.
 *   - It does NOT receive bridge deposits — `BridgeWatcher` mirrors
 *     Base USDC into the legacy Treasury. To fund this gas Treasury,
 *     the operator either grants allowance via `creditBalance(user, X)`
 *     directly (testnet/demo), or extends `BridgeWatcher` to mirror
 *     deposits into both (production).
 *
 * Output: prints the new address; appends `SporeGasTreasury` to
 * `contracts/deployments/og_testnet.json`.
 */
import { ethers, network } from 'hardhat'
import * as fs from 'fs'
import * as path from 'path'

async function main() {
  const [deployer] = await ethers.getSigners()
  console.log(`Network:  ${network.name}`)
  console.log(`Deployer: ${deployer.address}`)
  console.log(`(this address becomes both owner AND operator of the new Treasury)`)

  // Load existing deployments to grab the escrow address. We pass it
  // as the SwarmTreasury constructor's `_escrow` arg, but `gasMeter`
  // never invokes `spendOnBehalfOf` (the only caller of `escrow`), so
  // any non-zero address would technically work; reusing the real
  // escrow address keeps the wiring inspectable on a block explorer.
  const dep = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../deployments/og_testnet.json'), 'utf-8'),
  )
  const escrowAddress: string = dep.SwarmEscrow
  if (!escrowAddress) throw new Error('Could not find SwarmEscrow in deployments/og_testnet.json')

  console.log(`\nDeploying SwarmTreasury (sporeise gas)…`)
  console.log(`  escrow:   ${escrowAddress}`)
  console.log(`  operator: ${deployer.address}`)

  const SwarmTreasury = await ethers.getContractFactory('SwarmTreasury')
  const treasury = await SwarmTreasury.deploy(escrowAddress, deployer.address)
  await treasury.waitForDeployment()
  const treasuryAddress = await treasury.getAddress()

  console.log(`\n✓ Deployed at ${treasuryAddress}`)

  // Sanity reads — confirm owner + operator match our deployer.
  const onChainOwner: string = await (treasury as any).owner()
  const onChainOp: string = await (treasury as any).operator()
  console.log(`  owner():    ${onChainOwner}`)
  console.log(`  operator(): ${onChainOp}`)
  if (onChainOwner.toLowerCase() !== deployer.address.toLowerCase() ||
      onChainOp.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error('Sanity check failed — deployer is not owner+operator. Aborting before persisting.')
  }

  // Persist the address into deployments so the API + future scripts
  // can find it.
  dep.SporeGasTreasury = treasuryAddress
  dep.deployedAt = new Date().toISOString()
  fs.writeFileSync(
    path.join(__dirname, '../deployments/og_testnet.json'),
    JSON.stringify(dep, null, 2),
  )
  console.log(`\nSaved SporeGasTreasury → contracts/deployments/og_testnet.json`)

  console.log(`\nNext steps:`)
  console.log(`  1. Add this line to your .env (REPLACES any existing L2_SPORE_GAS_TREASURY_ADDRESS):`)
  console.log(`       L2_SPORE_GAS_TREASURY_ADDRESS=${treasuryAddress}`)
  console.log(`  2. Restart the API so chain.ts picks up the new env:`)
  console.log(`       docker compose up -d --build api`)
  console.log(`  3. Credit your wallet some starting USDC for sporeise:`)
  console.log(`       USER=<your wallet> AMOUNT_USDC=10 \\`)
  console.log(`         DEPLOYER_PRIVATE_KEY=$DEPLOYER_PRIVATE_KEY \\`)
  console.log(`         npx hardhat run scripts/credit-sporeise-balance.ts --network og_testnet`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
