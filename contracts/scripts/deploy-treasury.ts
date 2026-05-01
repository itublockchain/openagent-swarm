/**
 * Standalone deployer for SwarmTreasury — for the case where Escrow + USDC
 * are already deployed (existing testnet) and we want to add the SDK
 * Treasury layer without redeploying everything.
 *
 * Pre-req: Escrow contract MUST have the post-Phase-1.5 bytecode (with
 * `setTreasury` + `createTaskFor`). If you're pointing this at an older
 * deployment, run the full `deploy.ts` instead — there's no migration
 * path to add fields to a live contract.
 *
 * Reads addresses from deployments/og_testnet.json, writes the new
 * SwarmTreasury address back to the same file.
 */
import { ethers } from 'hardhat'
import * as fs from 'fs'
import * as path from 'path'

async function main() {
  const [deployer] = await ethers.getSigners()
  console.log('Deploying SwarmTreasury with:', deployer.address)

  const deploymentsPath = path.join(__dirname, '../deployments/og_testnet.json')
  if (!fs.existsSync(deploymentsPath)) {
    throw new Error('deployments/og_testnet.json not found — run full deploy.ts first')
  }
  const deployments = JSON.parse(fs.readFileSync(deploymentsPath, 'utf8')) as Record<string, string>

  const usdcAddress = deployments.MockUSDC
  const escrowAddress = deployments.SwarmEscrow
  if (!usdcAddress || !escrowAddress) {
    throw new Error('MockUSDC or SwarmEscrow missing from deployments file')
  }

  // Sanity: the existing Escrow needs the new bytecode. Probe by reading
  // the `treasuryInitialized` storage slot — old bytecode won't have it
  // and the call reverts/returns garbage.
  const escrow = await ethers.getContractAt('SwarmEscrow', escrowAddress)
  try {
    await escrow.treasuryInitialized()
  } catch {
    throw new Error(
      'Existing Escrow at ' +
        escrowAddress +
        ' does not expose treasuryInitialized — it predates Phase 1.5. Redeploy with full deploy.ts.',
    )
  }

  if (await escrow.treasuryInitialized()) {
    const existing = await escrow.treasury()
    console.log(
      `Escrow already wired to a Treasury at ${existing}. Aborting — re-deploying would orphan it.`,
    )
    console.log('To force a clean redeploy, run scripts/deploy.ts (overwrites everything).')
    return
  }

  console.log('Deploying SwarmTreasury...')
  const SwarmTreasury = await ethers.getContractFactory('SwarmTreasury')
  const treasury = await SwarmTreasury.deploy(usdcAddress, escrowAddress, deployer.address)
  await treasury.waitForDeployment()
  const treasuryAddress = await treasury.getAddress()
  console.log('SwarmTreasury:', treasuryAddress, '(operator:', deployer.address, ')')

  console.log('Wiring Escrow.setTreasury...')
  const tx = await escrow.setTreasury(treasuryAddress)
  await tx.wait()
  console.log('Wired.')

  // Persist alongside existing addresses.
  deployments.SwarmTreasury = treasuryAddress
  deployments.deployedAt = new Date().toISOString()
  fs.writeFileSync(deploymentsPath, JSON.stringify(deployments, null, 2))
  console.log('Saved to deployments/og_testnet.json')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
