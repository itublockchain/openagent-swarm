import { ethers } from 'hardhat'
import * as fs from 'fs'
import * as path from 'path'

/**
 * Targeted deploy for the SPORE SDK pathway:
 *   - SporeCoordinator (registry + state machine + BFT verify)
 *   - SwarmTreasury    (now with deductGas — billing for /v1/swarm/*)
 *
 * Leaves the existing MockUSDC, SwarmEscrow, DAGRegistry, SlashingVault,
 * AgentRegistry untouched — those addresses ship in `og_testnet.json`
 * and stay valid. We just add two new rows + replace SwarmTreasury.
 */
async function main() {
  const [deployer] = await ethers.getSigners()
  console.log('Deploying with:', deployer.address)
  const balance = await ethers.provider.getBalance(deployer.address)
  console.log('Balance:', ethers.formatEther(balance), 'A0GI')

  const deploymentsDir = path.join(__dirname, '../deployments')
  const deploymentsFile = path.join(deploymentsDir, 'og_testnet.json')
  const existing = JSON.parse(fs.readFileSync(deploymentsFile, 'utf-8'))
  console.log('Existing addresses:')
  for (const [k, v] of Object.entries(existing)) console.log(`  ${k}: ${v}`)

  const usdcAddress = existing.MockUSDC
  const escrowAddress = existing.SwarmEscrow
  if (!usdcAddress || !escrowAddress) {
    throw new Error('MockUSDC and SwarmEscrow must already be deployed (run scripts/deploy.ts for a full bootstrap)')
  }

  // 1. SwarmTreasury — redeploy (deductGas function added).
  console.log('\nDeploying SwarmTreasury (with deductGas)...')
  const SwarmTreasury = await ethers.getContractFactory('SwarmTreasury')
  const treasury = await SwarmTreasury.deploy(usdcAddress, escrowAddress, deployer.address)
  await treasury.waitForDeployment()
  const treasuryAddress = await treasury.getAddress()
  console.log('SwarmTreasury:', treasuryAddress)

  // 2. SporeCoordinator — new contract, no constructor args (pure
  //    registry + state machine, no funds held).
  console.log('\nDeploying SporeCoordinator...')
  const SporeCoordinator = await ethers.getContractFactory('SporeCoordinator')
  const coordinator = await SporeCoordinator.deploy()
  await coordinator.waitForDeployment()
  const coordinatorAddress = await coordinator.getAddress()
  console.log('SporeCoordinator:', coordinatorAddress)

  // 3. Update the deployments file in place. Other addresses preserved.
  const next = {
    ...existing,
    SwarmTreasury: treasuryAddress,
    SporeCoordinator: coordinatorAddress,
    deployedAt: new Date().toISOString(),
  }
  fs.writeFileSync(deploymentsFile, JSON.stringify(next, null, 2) + '\n')
  console.log('\nUpdated', deploymentsFile)
  console.log('\n✅ Deploy complete:')
  console.log('  SwarmTreasury    :', treasuryAddress)
  console.log('  SporeCoordinator :', coordinatorAddress)

  // 4. Friendly env-update reminder.
  console.log('\nNext: update the following keys in your .env / Dockerfiles:')
  console.log(`  L2_TREASURY_ADDRESS=${treasuryAddress}`)
  console.log(`  L2_SPORE_COORDINATOR_ADDRESS=${coordinatorAddress}`)
  console.log(`  NEXT_PUBLIC_TREASURY_ADDRESS=${treasuryAddress}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
