import { ethers } from 'hardhat'
import * as fs from 'fs'
import * as path from 'path'

/**
 * Standalone deploy for AgentRegistry. Use this when the rest of the system
 * (SwarmEscrow / DAGRegistry / SlashingVault) is already deployed and you
 * only want to bolt the public agent registry on top.
 *
 * Reads the existing contracts/deployments/og_testnet.json, deploys the new
 * contract, and writes the AgentRegistry address back into the same file
 * without touching the other entries.
 */
async function main() {
  const [deployer] = await ethers.getSigners()
  console.log('Deploying AgentRegistry with:', deployer.address)

  const AgentRegistry = await ethers.getContractFactory('AgentRegistry')
  const registry = await AgentRegistry.deploy()
  await registry.waitForDeployment()
  const address = await registry.getAddress()
  console.log('AgentRegistry:', address)

  const file = path.join(__dirname, '../deployments/og_testnet.json')
  if (!fs.existsSync(file)) {
    throw new Error(`deployments file missing: ${file}. Run scripts/deploy.ts first.`)
  }
  const current = JSON.parse(fs.readFileSync(file, 'utf-8'))
  current.AgentRegistry = address
  current.deployedAt = new Date().toISOString()
  fs.writeFileSync(file, JSON.stringify(current, null, 2))
  console.log('Updated', file)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
