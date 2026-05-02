/**
 * Deploys USDCGateway to Base Sepolia. The Gateway holds real USDC
 * custody for users; the API's BridgeWatcher mirrors `Deposited` events
 * into SwarmTreasury.balanceOf on 0G, and `release` is called to pay
 * out withdrawals after Treasury debit settles on 0G.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-base.ts --network base_sepolia
 *
 * Reads BASE_USDC_ADDRESS from env; defaults to Circle's canonical
 * Base Sepolia USDC. Operator is the deployer EOA — rotate to a
 * dedicated key/multisig before treating as production.
 */
import { ethers } from 'hardhat'
import * as fs from 'fs'
import * as path from 'path'

const DEFAULT_BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'

async function main() {
  const [deployer] = await ethers.getSigners()
  console.log('Deploying USDCGateway with:', deployer.address)

  const usdcAddress = process.env.BASE_USDC_ADDRESS || DEFAULT_BASE_SEPOLIA_USDC
  console.log('USDC token:', usdcAddress)

  const USDCGateway = await ethers.getContractFactory('USDCGateway')
  const gateway = await USDCGateway.deploy(usdcAddress, deployer.address)
  await gateway.waitForDeployment()
  const gatewayAddress = await gateway.getAddress()
  console.log('USDCGateway:', gatewayAddress, '(operator:', deployer.address, ')')

  const addresses = {
    USDCGateway: gatewayAddress,
    USDC: usdcAddress,
    network: 'base_sepolia',
    deployedAt: new Date().toISOString(),
  }

  const deploymentsDir = path.join(__dirname, '../deployments')
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir)
  fs.writeFileSync(path.join(deploymentsDir, 'base_sepolia.json'), JSON.stringify(addresses, null, 2))
  console.log('Saved to deployments/base_sepolia.json')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
