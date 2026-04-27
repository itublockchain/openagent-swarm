import { ethers } from 'hardhat'
import * as fs from 'fs'
import * as path from 'path'

async function main() {
  const [deployer] = await ethers.getSigners()
  console.log('Deploying with:', deployer.address)

  // 0. MockERC20 (Used as USDC)
  console.log('Deploying MockERC20...')
  const MockERC20 = await ethers.getContractFactory('MockERC20')
  const usdc = await MockERC20.deploy('Mock USDC', 'mUSDC')
  await usdc.waitForDeployment()
  const usdcAddress = await usdc.getAddress()
  console.log('MockERC20 (USDC):', usdcAddress)

  // 1. SwarmEscrow
  console.log('Deploying SwarmEscrow...')
  const SwarmEscrow = await ethers.getContractFactory('SwarmEscrow')
  const escrow = await SwarmEscrow.deploy(usdcAddress)
  await escrow.waitForDeployment()
  const escrowAddress = await escrow.getAddress()
  console.log('SwarmEscrow:', escrowAddress)

  // 2. DAGRegistry
  console.log('Deploying DAGRegistry...')
  const DAGRegistry = await ethers.getContractFactory('DAGRegistry')
  const registry = await DAGRegistry.deploy()
  await registry.waitForDeployment()
  const registryAddress = await registry.getAddress()
  console.log('DAGRegistry:', registryAddress)

  // 3. SlashingVault
  console.log('Deploying SlashingVault...')
  const SlashingVault = await ethers.getContractFactory('SlashingVault')
  const vault = await SlashingVault.deploy(escrowAddress, registryAddress)
  await vault.waitForDeployment()
  const vaultAddress = await vault.getAddress()
  console.log('SlashingVault:', vaultAddress)

  // 4. Setup Connections
  console.log('Setting up contract connections...')
  
  // Set addresses in Registry
  const setRegTx = await registry.setAddresses(escrowAddress, vaultAddress)
  await setRegTx.wait()
  console.log('Registry addresses set.')

  // Set authorities in Escrow
  const setEscrowTx = await escrow.setAuthorities(registryAddress, vaultAddress)
  await setEscrowTx.wait()
  console.log('Escrow authorities set.')

  // Adresleri kaydet
  const addresses = {
    MockUSDC: usdcAddress,
    SwarmEscrow: escrowAddress,
    DAGRegistry: registryAddress,
    SlashingVault: vaultAddress,
    network: 'og_testnet',
    deployedAt: new Date().toISOString(),
  }

  const deploymentsDir = path.join(__dirname, '../deployments')
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir)
  }

  fs.writeFileSync(
    path.join(deploymentsDir, 'og_testnet.json'),
    JSON.stringify(addresses, null, 2)
  )
  console.log('Saved to deployments/og_testnet.json')

  // Log for .env update
  console.log('\n--- Update your .env file with these values ---')
  console.log(`L2_USDC_ADDRESS=${usdcAddress}`)
  console.log(`L2_ESCROW_ADDRESS=${escrowAddress}`)
  console.log(`L2_DAG_REGISTRY_ADDRESS=${registryAddress}`)
  console.log(`L2_SLASHING_VAULT_ADDRESS=${vaultAddress}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
