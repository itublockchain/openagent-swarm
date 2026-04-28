import { ethers } from 'hardhat'
import * as fs from 'fs'
import * as path from 'path'

async function main() {
  const [deployer] = await ethers.getSigners()
  console.log('Deploying with:', deployer.address)

  // 0. MockERC20 (USDC for Testnet)
  console.log('Deploying MockERC20...')
  const MockERC20 = await ethers.getContractFactory('MockERC20')
  const usdc = await MockERC20.deploy('Mock USDC', 'mUSDC')
  await usdc.waitForDeployment()
  const usdcAddress = await usdc.getAddress()
  console.log('MockERC20 (USDC):', usdcAddress)

  // 0.1 Mint for the deployer (API wallet)
  console.log('Minting USDC to deployer...')
  const mintTx = await usdc.mint(deployer.address, ethers.parseEther('1000'))
  await mintTx.wait()

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
  const setRegTx = await registry.setAddresses(escrowAddress, vaultAddress)
  await setRegTx.wait()
  const setEscrowTx = await escrow.setAuthorities(registryAddress, vaultAddress)
  await setEscrowTx.wait()
  
  // 5. Approve Escrow
  console.log('Approving SwarmEscrow to spend USDC...')
  const approveTx = await usdc.approve(escrowAddress, ethers.MaxUint256)
  await approveTx.wait()
  console.log('Approved.')

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
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir)
  fs.writeFileSync(path.join(deploymentsDir, 'og_testnet.json'), JSON.stringify(addresses, null, 2))
  console.log('Saved to deployments/og_testnet.json')
}

main().catch(console.error)
