import { ethers } from 'hardhat'
import * as fs from 'fs'
import * as path from 'path'

async function main() {
  const deploymentPath = path.join(__dirname, '../deployments/og_testnet.json')
  if (!fs.existsSync(deploymentPath)) {
    console.error('Deployment file not found!')
    return
  }

  const addresses = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'))
  console.log('Verifying deployment on:', addresses.network)

  const [deployer] = await ethers.getSigners()
  console.log('Using account:', deployer.address)

  // 1. Check Registry
  const registry = await ethers.getContractAt('DAGRegistry', addresses.DAGRegistry)
  const regEscrow = await registry.escrow()
  const regVault = await registry.vault()
  
  console.log('Registry -> Escrow:', regEscrow)
  console.log('Registry -> Vault:', regVault)

  const regOk = regEscrow === addresses.SwarmEscrow && regVault === addresses.SlashingVault
  console.log('Registry Connections:', regOk ? 'OK' : 'FAILED')

  // 2. Check Escrow
  const escrow = await ethers.getContractAt('SwarmEscrow', addresses.SwarmEscrow)
  const escrowReg = await escrow.registry()
  const escrowVault = await escrow.vault()
  const escrowOperator = await escrow.operator()
  const escrowTreasury = await escrow.treasury()

  console.log('Escrow -> Registry:', escrowReg)
  console.log('Escrow -> Vault:', escrowVault)
  console.log('Escrow -> Operator:', escrowOperator)
  console.log('Escrow -> Treasury:', escrowTreasury)

  const escrowOk =
    escrowReg === addresses.DAGRegistry &&
    escrowVault === addresses.SlashingVault &&
    escrowTreasury === addresses.SwarmTreasury
  console.log('Escrow Connections:', escrowOk ? 'OK' : 'FAILED')

  // 3. Check SlashingVault
  const vault = await ethers.getContractAt('SlashingVault', addresses.SlashingVault)
  const vaultEscrow = await vault.escrow()
  const vaultReg = await vault.registry()

  console.log('Vault -> Escrow:', vaultEscrow)
  console.log('Vault -> Registry:', vaultReg)

  const vaultOk = vaultEscrow === addresses.SwarmEscrow && vaultReg === addresses.DAGRegistry
  console.log('Vault Connections:', vaultOk ? 'OK' : 'FAILED')

  if (regOk && escrowOk && vaultOk) {
    console.log('\n--- ALL VERIFICATIONS PASSED ---')
  } else {
    console.error('\n--- VERIFICATION FAILED ---')
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
