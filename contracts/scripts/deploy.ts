/**
 * Deploys the tokenless swarm stack to 0G Galileo testnet:
 *   SwarmEscrow → DAGRegistry → AgentRegistry → SlashingVault → SwarmTreasury
 *
 * No ERC20 anywhere. Real USDC custody lives on Base Sepolia
 * (USDCGateway, deployed via deploy-base.ts). The API operator bridges
 * deposits into Treasury.balanceOf and withdrawals back to the gateway.
 */
import { ethers } from 'hardhat'
import * as fs from 'fs'
import * as path from 'path'

async function main() {
  const [deployer] = await ethers.getSigners()
  console.log('Deploying with:', deployer.address)

  // 1. SwarmEscrow — operator EOA = deployer (rotate later for prod).
  console.log('Deploying SwarmEscrow...')
  const SwarmEscrow = await ethers.getContractFactory('SwarmEscrow')
  const escrow = await SwarmEscrow.deploy(deployer.address)
  await escrow.waitForDeployment()
  const escrowAddress = await escrow.getAddress()
  console.log('SwarmEscrow:', escrowAddress, '(operator:', deployer.address, ')')

  // 2. DAGRegistry
  console.log('Deploying DAGRegistry...')
  const DAGRegistry = await ethers.getContractFactory('DAGRegistry')
  const registry = await DAGRegistry.deploy()
  await registry.waitForDeployment()
  const registryAddress = await registry.getAddress()
  console.log('DAGRegistry:', registryAddress)

  // 3. AgentRegistry — must be deployed BEFORE SlashingVault.
  console.log('Deploying AgentRegistry...')
  const AgentRegistry = await ethers.getContractFactory('AgentRegistry')
  const agentRegistry = await AgentRegistry.deploy()
  await agentRegistry.waitForDeployment()
  const agentRegistryAddress = await agentRegistry.getAddress()
  console.log('AgentRegistry:', agentRegistryAddress)

  // 4. SlashingVault.
  console.log('Deploying SlashingVault...')
  const SlashingVault = await ethers.getContractFactory('SlashingVault')
  const vault = await SlashingVault.deploy(escrowAddress, registryAddress, agentRegistryAddress)
  await vault.waitForDeployment()
  const vaultAddress = await vault.getAddress()
  console.log('SlashingVault:', vaultAddress)

  // 5. Wire DAGRegistry + Escrow authorities.
  console.log('Setting up contract connections...')
  const setRegTx = await registry.setAddresses(escrowAddress, vaultAddress)
  await setRegTx.wait()
  const setEscrowTx = await escrow.setAuthorities(registryAddress, vaultAddress)
  await setEscrowTx.wait()

  // 6. SwarmTreasury — operator = deployer initially. Wire Escrow.setTreasury
  // so `createTaskFor` accepts Treasury calls.
  console.log('Deploying SwarmTreasury...')
  const SwarmTreasury = await ethers.getContractFactory('SwarmTreasury')
  const treasury = await SwarmTreasury.deploy(escrowAddress, deployer.address)
  await treasury.waitForDeployment()
  const treasuryAddress = await treasury.getAddress()
  console.log('SwarmTreasury:', treasuryAddress, '(operator:', deployer.address, ')')
  const setTreasuryTx = await escrow.setTreasury(treasuryAddress)
  await setTreasuryTx.wait()
  console.log('Wired Escrow.setTreasury → Treasury')

  const addresses = {
    SwarmEscrow: escrowAddress,
    DAGRegistry: registryAddress,
    SlashingVault: vaultAddress,
    AgentRegistry: agentRegistryAddress,
    SwarmTreasury: treasuryAddress,
    network: 'og_testnet',
    deployedAt: new Date().toISOString(),
  }

  const deploymentsDir = path.join(__dirname, '../deployments')
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir)
  fs.writeFileSync(path.join(deploymentsDir, 'og_testnet.json'), JSON.stringify(addresses, null, 2))
  console.log('Saved to deployments/og_testnet.json')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
