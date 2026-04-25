import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import pkg from "hardhat";
const { ethers } = pkg;

describe("SwarmEscrow", function () {
  async function deployFixture() {
    const [owner, user, agent] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockERC20");
    const usdc = await Token.deploy();
    await usdc.mint(owner.address, ethers.parseUnits("1000", 6));
    const Escrow = await ethers.getContractFactory("SwarmEscrow");
    const escrow = await Escrow.deploy(await usdc.getAddress());
    return { escrow, usdc, owner, user, agent };
  }

  it("should create a task and lock budget", async function () {
    const { escrow, usdc, user } = await loadFixture(deployFixture);
    const taskId = ethers.id("task-1");
    const budget = ethers.parseUnits("100", 6);
    await usdc.transfer(user.address, budget);
    await usdc.connect(user).approve(await escrow.getAddress(), budget);
    await escrow.connect(user).createTask(taskId, budget);
    const task = await escrow.tasks(taskId);
    expect(task.budget).to.equal(budget);
  });
});
