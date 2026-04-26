import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import pkg from "hardhat";
const { ethers } = pkg;

describe("DAGRegistry", function () {
  async function deployFixture() {
    const [owner, agent] = await ethers.getSigners();
    const Registry = await ethers.getContractFactory("DAGRegistry");
    const registry = await Registry.deploy();
    return { registry, owner, agent };
  }

  it("should claim planner correctly", async function () {
    const { registry, agent } = await loadFixture(deployFixture);
    const taskId = ethers.id("task-1");
    expect(await registry.connect(agent).claimPlanner.staticCall(taskId)).to.be.true;
    await registry.connect(agent).claimPlanner(taskId);
    expect(await registry.connect(agent).claimPlanner.staticCall(taskId)).to.be.false;
  });
});
