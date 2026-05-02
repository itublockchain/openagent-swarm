/**
 * Operator-side credit for the sporeise gas Treasury. Use this to seed
 * a user's sporeise balance without going through the bridge — useful
 * for testnet demos where there's no real USDC pipeline yet.
 *
 *   USER=0x7D4cc79C…  AMOUNT_USDC=10 \
 *     DEPLOYER_PRIVATE_KEY=0x… \
 *     npx hardhat run scripts/credit-sporeise-balance.ts --network og_testnet
 *
 * Required env:
 *   - USER                 EOA to credit (the wallet bound to the user's
 *                          API key — same address that signed in via SIWE)
 *   - AMOUNT_USDC          decimal string, e.g. "10" or "5.5"
 *   - DEPLOYER_PRIVATE_KEY operator EOA whose address matches
 *                          SporeGasTreasury.operator()
 *
 * Optional env:
 *   - L2_SPORE_GAS_TREASURY_ADDRESS  defaults to the address recorded as
 *                                    `SporeGasTreasury` in
 *                                    contracts/deployments/og_testnet.json
 *                                    (written by deploy-sporeise-gas-treasury.ts)
 *
 * Notes:
 *   - The Treasury is tokenless — this is a pure ledger entry, no real
 *     USDC moves. The operator is recording a credit it commits to honour;
 *     in production this should mirror Base USDC deposits like
 *     BridgeWatcher does for the legacy SwarmTreasury.
 *   - Re-running adds another credit each time; no on-chain dedupe.
 */
import { ethers, network } from 'hardhat'
import * as fs from 'fs'
import * as path from 'path'

const USDC_DECIMALS = 6

async function main() {
  const userAddr = process.env.USER
  const amountStr = process.env.AMOUNT_USDC
  if (!userAddr || !/^0x[0-9a-fA-F]{40}$/.test(userAddr)) {
    throw new Error('USER must be a 0x-prefixed 20-byte address')
  }
  if (!amountStr || !/^\d+(\.\d+)?$/.test(amountStr)) {
    throw new Error('AMOUNT_USDC must be a positive decimal string, e.g. "10"')
  }

  // Resolve the gas treasury address. Priority:
  //   1. L2_SPORE_GAS_TREASURY_ADDRESS env (matches API runtime config)
  //   2. deployments/og_testnet.json `SporeGasTreasury`
  let gasTreasuryAddr = process.env.L2_SPORE_GAS_TREASURY_ADDRESS
  if (!gasTreasuryAddr) {
    const dep = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../deployments/og_testnet.json'), 'utf-8'),
    )
    gasTreasuryAddr = dep.SporeGasTreasury
  }
  if (!gasTreasuryAddr) {
    throw new Error(
      'Could not resolve gas Treasury address. ' +
      'Set L2_SPORE_GAS_TREASURY_ADDRESS, or run deploy-sporeise-gas-treasury.ts first.',
    )
  }

  const [deployer] = await ethers.getSigners()
  console.log(`Network:        ${network.name}`)
  console.log(`Gas Treasury:   ${gasTreasuryAddr}`)
  console.log(`Operator:       ${deployer.address}`)
  console.log(`User to credit: ${userAddr}`)
  console.log(`Amount:         ${amountStr} USDC`)

  const abi = [
    'function operator() view returns (address)',
    'function balanceOf(address) view returns (uint256)',
    'function creditBalance(address user, uint256 amount)',
  ]
  const treasury = new ethers.Contract(gasTreasuryAddr, abi, deployer)

  const onChainOp: string = await treasury.operator()
  if (onChainOp.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(
      `Deployer (${deployer.address}) is not the gas Treasury operator (${onChainOp}). ` +
      `Did you point at the right Treasury? Use the address from deploy-sporeise-gas-treasury.ts.`,
    )
  }

  const before = (await treasury.balanceOf(userAddr)) as bigint
  console.log(`\nBalance before: ${ethers.formatUnits(before, USDC_DECIMALS)} USDC`)

  const amountWei = ethers.parseUnits(amountStr, USDC_DECIMALS)
  const tx = await treasury.creditBalance(userAddr, amountWei)
  console.log(`creditBalance tx: ${tx.hash}`)
  const receipt = await tx.wait()
  console.log(`Mined in block ${receipt?.blockNumber}`)

  const after = (await treasury.balanceOf(userAddr)) as bigint
  console.log(`Balance after:  ${ethers.formatUnits(after, USDC_DECIMALS)} USDC`)
  console.log(`\n✓ Credited ${amountStr} USDC to ${userAddr} on the sporeise gas Treasury.`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
