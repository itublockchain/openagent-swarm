/**
 * Mint MockUSDC to a target address. MockERC20.mint is public so any signer
 * with 0G testnet gas can call it; this script reuses the configured
 * deployer (PRIVATE_KEY in root .env) just to pay gas.
 *
 * Usage:
 *   TARGET=0x... AMOUNT=1000 \
 *     npx hardhat run scripts/seed-usdc.ts --network og_testnet
 *
 * AMOUNT is in whole USDC units (script multiplies by 10**decimals).
 * Defaults: AMOUNT=1000.
 */
import { ethers } from 'hardhat'
import * as fs from 'fs'
import * as path from 'path'

async function main() {
  const target = process.env.TARGET
  if (!target || !ethers.isAddress(target)) {
    throw new Error('Set TARGET=<0x...> in env (recipient address)')
  }
  const amountWhole = process.env.AMOUNT ? Number(process.env.AMOUNT) : 1000
  if (!Number.isFinite(amountWhole) || amountWhole <= 0) {
    throw new Error(`Invalid AMOUNT: ${process.env.AMOUNT}`)
  }

  const deploymentsPath = path.join(__dirname, '../deployments/og_testnet.json')
  const deployments = JSON.parse(fs.readFileSync(deploymentsPath, 'utf8')) as Record<string, string>
  const usdcAddress = deployments.MockUSDC
  if (!usdcAddress) throw new Error('MockUSDC missing from deployments file')

  const [signer] = await ethers.getSigners()
  console.log(`Signer:  ${signer.address}`)
  console.log(`USDC:    ${usdcAddress}`)
  console.log(`Target:  ${target}`)

  const usdc = await ethers.getContractAt('MockERC20', usdcAddress, signer)
  const decimals: number = Number(await usdc.decimals())
  const amountWei = ethers.parseUnits(amountWhole.toString(), decimals)

  const before: bigint = await usdc.balanceOf(target)
  console.log(`Balance before: ${ethers.formatUnits(before, decimals)} USDC`)

  console.log(`Minting ${amountWhole} USDC (${amountWei} wei)...`)
  const tx = await usdc.mint(target, amountWei)
  console.log(`tx: ${tx.hash}`)
  await tx.wait()

  const after: bigint = await usdc.balanceOf(target)
  console.log(`Balance after:  ${ethers.formatUnits(after, decimals)} USDC`)
  console.log('Done.')
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err)
    process.exit(1)
  })
