const { ethers } = require('ethers');
const SwarmEscrowABI = require('./contracts/artifacts/src/SwarmEscrow.sol/SwarmEscrow.json');
const deployments = require('./contracts/deployments/og_testnet.json');

const rpcUrl = process.env.OG_RPC_URL || 'https://evmrpc-testnet.0g.ai';
const provider = new ethers.JsonRpcProvider(rpcUrl);

const escrowAddr = deployments.SwarmEscrow;
const escrow = new ethers.Contract(escrowAddr, SwarmEscrowABI.abi, provider);

async function check() {
  const agentAddress = '0xE3665a399a1885Ef2b209b215970f95E51fB77a2'; // from name3-moni4w3g logs ("from")
  const balance = await escrow.agentBalances(agentAddress);
  console.log(`Balance of ${agentAddress}: ${balance.toString()} (6 decimals)`);
}

check().catch(console.error);
