import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

// Load root .env
dotenv.config({ path: "../.env" });

const PRIVATE_KEY = process.env.PRIVATE_KEY || "";

const config: HardhatUserConfig = {
  // Bumped from 0.8.20 → 0.8.24 for OpenZeppelin MessageHashUtils
  // (used by SporeCoordinator's ECDSA recovery). evmVersion=cancun is
  // required for the OZ Bytes.sol mcopy opcode that 5.4+ depends on.
  // 0G Galileo testnet supports cancun.
  solidity: {
    version: "0.8.24",
    settings: {
      evmVersion: "cancun",
      optimizer: { enabled: true, runs: 200 },
      // submitValidations stack depth requires viaIR — without it the
      // function exceeds the EVM's 16-slot local-var limit.
      viaIR: true,
    },
  },
  networks: {
    og_testnet: {
      url: "https://evmrpc-testnet.0g.ai",
      chainId: 16602,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
    base_sepolia: {
      url: process.env.BASE_RPC_URL || "https://sepolia.base.org",
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
