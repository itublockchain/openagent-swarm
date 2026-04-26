import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import pkg from "hardhat";
const { ethers } = pkg;

describe("SlashingVault", function () {
  async function deployFixture() {
    const [owner, challenger, accused] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockERC20");
    const usdc = await Token.deploy();
    await usdc.mint(owner.address, ethers.parseUnits("1000", 6));
    const Escrow = await ethers.getContractFactory("SwarmEscrow");
    const escrow = await Escrow.deploy(await usdc.getAddress());
    const Registry = await ethers.getContractFactory("DAGRegistry");
    const registry = await Registry.deploy();
    const Vault = await ethers.getContractFactory("SlashingVault");
    const vault = await Vault.deploy(await escrow.getAddress(), await registry.getAddress());
    return { vault, escrow, registry, challenger, accused };
  }

  it("should raise a challenge", async function () {
    const { vault, challenger, accused } = await loadFixture(deployFixture);
    const nodeId = ethers.id("node-1");
    await expect(vault.connect(challenger).challenge(nodeId, accused.address))
      .to.emit(vault, "ChallengeRaised")
      .withArgs(nodeId, challenger.address, accused.address);
  });
});
