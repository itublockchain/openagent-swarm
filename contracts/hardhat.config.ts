import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

// Load root .env
dotenv.config({ path: "../.env" });

const PRIVATE_KEY = process.env.PRIVATE_KEY || "";

const config: HardhatUserConfig = {
  solidity: "0.8.20",
  networks: {
    og_testnet: {
      url: "https://evmrpc-testnet.0g.ai",
      chainId: 16602,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
    base_sepolia: {
      url: process.env.L2_RPC_URL || "https://sepolia.base.org",
      chainId: 84532,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
  },
  paths: {
    sources: "./src",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts"
  }
};

export default config;
