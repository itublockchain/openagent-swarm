const { ethers } = require('ethers');
async function run() {
  const provider = new ethers.JsonRpcProvider('https://sepolia.base.org');
  const abi = ["event Deposited(address indexed user, uint256 amount)"];
  const contract = new ethers.Contract('0x409e4d7af7fc0641c8f070c79d13ecb94d91e443', abi, provider);
  const head = await provider.getBlockNumber();
  const events = await contract.queryFilter(contract.filters.Deposited(), head - 10000, head);
  if (events.length > 0) {
    console.log("Index:", events[0].index, "LogIndex:", events[0].logIndex);
    console.log("Keys:", Object.keys(events[0]));
  } else {
    console.log("No events found in last 10000 blocks");
  }
}
run();
