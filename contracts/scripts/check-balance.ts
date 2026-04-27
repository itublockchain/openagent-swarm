import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();

  if (!deployer) {
    console.error("No deployer account found. Check your PRIVATE_KEY in .env");
    return;
  }

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Account:", deployer.address);
  console.log("Balance:", ethers.formatEther(balance), "A0GI");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
