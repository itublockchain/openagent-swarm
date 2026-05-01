import { expect } from 'chai'
import { ethers } from 'hardhat'
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers'

const TASK = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s))
const E = (n: string) => ethers.parseEther(n)

describe('SwarmTreasury (tokenless)', () => {
  let escrow: any, treasury: any
  let owner: SignerWithAddress, operator: SignerWithAddress
  let user: SignerWithAddress, other: SignerWithAddress

  beforeEach(async () => {
    ;[owner, operator, user, other] = await ethers.getSigners()

    const Escrow = await ethers.getContractFactory('SwarmEscrow')
    escrow = await Escrow.deploy(operator.address)
    await escrow.waitForDeployment()

    const Treasury = await ethers.getContractFactory('SwarmTreasury')
    treasury = await Treasury.deploy(await escrow.getAddress(), operator.address)
    await treasury.waitForDeployment()

    await escrow.setTreasury(await treasury.getAddress())
  })

  // ----------------------------------------------------------------
  describe('credit / debit (bridge ops)', () => {
    it('creditBalance increments user balance + emits event', async () => {
      await expect(treasury.connect(operator).creditBalance(user.address, E('10')))
        .to.emit(treasury, 'Credited')
        .withArgs(user.address, E('10'), E('10'))
      expect(await treasury.balanceOf(user.address)).to.equal(E('10'))
    })

    it('creditBalance rejects zero amount', async () => {
      await expect(treasury.connect(operator).creditBalance(user.address, 0))
        .to.be.revertedWith('zero amount')
    })

    it('creditBalance rejects zero address', async () => {
      await expect(treasury.connect(operator).creditBalance(ethers.ZeroAddress, E('1')))
        .to.be.revertedWith('user=0')
    })

    it('creditBalance gated by operator', async () => {
      await expect(treasury.connect(other).creditBalance(user.address, E('1')))
        .to.be.revertedWith('not operator')
    })

    it('debitBalance subtracts user balance + emits event', async () => {
      await treasury.connect(operator).creditBalance(user.address, E('10'))
      await expect(treasury.connect(operator).debitBalance(user.address, E('4')))
        .to.emit(treasury, 'Debited')
        .withArgs(user.address, E('4'), E('6'))
      expect(await treasury.balanceOf(user.address)).to.equal(E('6'))
    })

    it('debitBalance rejects over-debit', async () => {
      await treasury.connect(operator).creditBalance(user.address, E('1'))
      await expect(treasury.connect(operator).debitBalance(user.address, E('5')))
        .to.be.revertedWith('insufficient balance')
    })

    it('debitBalance gated by operator', async () => {
      await treasury.connect(operator).creditBalance(user.address, E('5'))
      await expect(treasury.connect(other).debitBalance(user.address, E('1')))
        .to.be.revertedWith('not operator')
    })
  })

  // ----------------------------------------------------------------
  describe('spendOnBehalfOf', () => {
    const t1 = TASK('task-1')

    beforeEach(async () => {
      await treasury.connect(operator).creditBalance(user.address, E('20'))
    })

    it('debits balance + creates task in escrow with user as owner', async () => {
      await expect(treasury.connect(operator).spendOnBehalfOf(user.address, t1, E('5')))
        .to.emit(treasury, 'SpentOnBehalf')
        .withArgs(user.address, t1, E('5'))
        .and.to.emit(escrow, 'TaskCreated')
        .withArgs(t1, user.address, E('5'))

      expect(await treasury.balanceOf(user.address)).to.equal(E('15'))
      const task = await escrow.tasks(t1)
      expect(task.owner).to.equal(user.address)
      expect(task.budget).to.equal(E('5'))
    })

    it('rejects when balance is insufficient', async () => {
      await expect(treasury.connect(operator).spendOnBehalfOf(user.address, t1, E('999')))
        .to.be.revertedWith('insufficient balance')
    })

    it('rejects from non-operator', async () => {
      await expect(treasury.connect(other).spendOnBehalfOf(user.address, t1, E('1')))
        .to.be.revertedWith('not operator')
    })

    it('respects pause', async () => {
      await treasury.connect(owner).pause()
      await expect(treasury.connect(operator).spendOnBehalfOf(user.address, t1, E('1')))
        .to.be.reverted
    })

    it('rejects zero amount', async () => {
      await expect(treasury.connect(operator).spendOnBehalfOf(user.address, t1, 0))
        .to.be.revertedWith('zero amount')
    })

    it('rejects zero user', async () => {
      await expect(treasury.connect(operator).spendOnBehalfOf(ethers.ZeroAddress, t1, E('1')))
        .to.be.revertedWith('user=0')
    })
  })

  // ----------------------------------------------------------------
  describe('owner — operator rotation + pause', () => {
    it('setOperator only by owner', async () => {
      await expect(treasury.connect(other).setOperator(other.address)).to.be.reverted
      await expect(treasury.connect(owner).setOperator(other.address))
        .to.emit(treasury, 'OperatorChanged')
        .withArgs(operator.address, other.address)
      expect(await treasury.operator()).to.equal(other.address)
    })

    it('setOperator rejects zero address', async () => {
      await expect(treasury.connect(owner).setOperator(ethers.ZeroAddress))
        .to.be.revertedWith('operator=0')
    })

    it('pause only by owner', async () => {
      await expect(treasury.connect(other).pause()).to.be.reverted
      await treasury.connect(owner).pause()
      expect(await treasury.paused()).to.equal(true)
    })
  })

  // ----------------------------------------------------------------
  describe('SwarmEscrow.createTaskFor', () => {
    const t1 = TASK('only-treasury')

    it('rejects calls from non-treasury', async () => {
      await expect(
        escrow.connect(operator).createTaskFor(t1, E('1'), user.address),
      ).to.be.revertedWith('Only treasury')
    })

    it('rejects re-init of treasury', async () => {
      await expect(escrow.setTreasury(await treasury.getAddress()))
        .to.be.revertedWith('Treasury already set')
    })

    it('rejects zero owner', async () => {
      // Redeploy a fresh Escrow with `operator` posing as the treasury so we
      // can call createTaskFor directly.
      const Escrow2 = await ethers.getContractFactory('SwarmEscrow')
      const escrow2 = await Escrow2.deploy(operator.address)
      await escrow2.waitForDeployment()
      await escrow2.setTreasury(operator.address)
      await expect(
        escrow2.connect(operator).createTaskFor(t1, E('1'), ethers.ZeroAddress),
      ).to.be.revertedWith('Zero owner')
    })
  })
})

describe('SwarmEscrow (tokenless agent ledger)', () => {
  let escrow: any
  let operator: SignerWithAddress, registry: SignerWithAddress, vault: SignerWithAddress
  let agent: SignerWithAddress, otherAgent: SignerWithAddress, challenger: SignerWithAddress

  beforeEach(async () => {
    ;[operator, registry, vault, agent, otherAgent, challenger] = await ethers.getSigners()

    const Escrow = await ethers.getContractFactory('SwarmEscrow')
    escrow = await Escrow.deploy(operator.address)
    await escrow.waitForDeployment()
    await escrow.setAuthorities(registry.address, vault.address)
    await escrow.setTreasury(operator.address) // operator poses as treasury for createTaskFor
  })

  describe('agent ledger (creditAgent / debitAgent)', () => {
    it('creditAgent + debitAgent flow', async () => {
      await expect(escrow.connect(operator).creditAgent(agent.address, E('10')))
        .to.emit(escrow, 'AgentCredited')
        .withArgs(agent.address, E('10'), E('10'))
      expect(await escrow.agentBalances(agent.address)).to.equal(E('10'))

      await expect(escrow.connect(operator).debitAgent(agent.address, E('4')))
        .to.emit(escrow, 'AgentDebited')
        .withArgs(agent.address, E('4'), E('6'))
      expect(await escrow.agentBalances(agent.address)).to.equal(E('6'))
    })

    it('creditAgent gated by operator', async () => {
      await expect(escrow.connect(agent).creditAgent(agent.address, E('1')))
        .to.be.revertedWith('not operator')
    })

    it('debitAgent rejects over-debit', async () => {
      await escrow.connect(operator).creditAgent(agent.address, E('1'))
      await expect(escrow.connect(operator).debitAgent(agent.address, E('5')))
        .to.be.revertedWith('insufficient agent balance')
    })
  })

  describe('subtask staking', () => {
    const t1 = TASK('task-stake')
    const n1 = TASK('node-1')

    beforeEach(async () => {
      // Treasury (= operator in tests) creates a task; operator credits agents.
      await escrow.connect(operator).createTaskFor(t1, E('100'), agent.address)
      await escrow.connect(operator).creditAgent(agent.address, E('10'))
      await escrow.connect(operator).creditAgent(otherAgent.address, E('10'))
    })

    it('agent stakes for subtask, debits its own balance', async () => {
      await expect(escrow.connect(agent).stakeForSubtask(t1, n1, E('3')))
        .to.emit(escrow, 'SubtaskStaked')
        .withArgs(t1, n1, agent.address, E('3'))
      expect(await escrow.agentBalances(agent.address)).to.equal(E('7'))
      expect(await escrow.subtaskStakes(t1, n1, agent.address)).to.equal(E('3'))
      expect(await escrow.subtaskStakeOwners(t1, n1)).to.equal(agent.address)
    })

    it('rejects double-stake on same subtask', async () => {
      await escrow.connect(agent).stakeForSubtask(t1, n1, E('3'))
      await expect(escrow.connect(otherAgent).stakeForSubtask(t1, n1, E('3')))
        .to.be.revertedWith('Subtask already staked')
    })

    it('insufficient agent balance reverts', async () => {
      await expect(escrow.connect(agent).stakeForSubtask(t1, n1, E('999')))
        .to.be.revertedWith('insufficient balance')
    })

    it('releaseSubtaskStake refunds to agentBalances', async () => {
      await escrow.connect(agent).stakeForSubtask(t1, n1, E('3'))
      await expect(escrow.connect(registry).releaseSubtaskStake(t1, n1))
        .to.emit(escrow, 'SubtaskStakeReleased')
        .withArgs(t1, n1, agent.address, E('3'))
      expect(await escrow.agentBalances(agent.address)).to.equal(E('10'))
      expect(await escrow.subtaskStakes(t1, n1, agent.address)).to.equal(0n)
    })

    it('releaseSubtaskStake gated by registry', async () => {
      await escrow.connect(agent).stakeForSubtask(t1, n1, E('3'))
      await expect(escrow.connect(operator).releaseSubtaskStake(t1, n1))
        .to.be.revertedWith('Caller is not the registry')
    })
  })

  describe('slashing (vault-only)', () => {
    const t1 = TASK('task-slash')
    const n1 = TASK('node-slash')

    beforeEach(async () => {
      await escrow.connect(operator).createTaskFor(t1, E('100'), agent.address)
      await escrow.connect(operator).creditAgent(agent.address, E('10'))
      await escrow.connect(operator).creditAgent(challenger.address, E('5'))
      await escrow.connect(agent).stakeForSubtask(t1, n1, E('5'))
    })

    it('slashSubtaskPartial burns + rewards + refunds', async () => {
      // 80% burn, 20% reward to challenger
      await expect(
        escrow.connect(vault).slashSubtaskPartial(t1, n1, agent.address, 8000, challenger.address, 2000),
      ).to.emit(escrow, 'Slashed').withArgs(t1, agent.address, E('5'))

      // 5 stake → 4 burned (totalSlashed) + 1 reward → challenger
      expect(await escrow.totalSlashed()).to.equal(E('4'))
      expect(await escrow.agentBalances(challenger.address)).to.equal(E('6')) // 5 + 1
      // Agent's stake is fully spent on burn+reward, original 10 - 5 (staked) = 5 left
      expect(await escrow.agentBalances(agent.address)).to.equal(E('5'))
    })

    it('slashSubtaskPartial rejects from non-vault', async () => {
      await expect(
        escrow.connect(operator).slashSubtaskPartial(t1, n1, agent.address, 5000, challenger.address, 0),
      ).to.be.revertedWith('Caller is not the vault')
    })

    it('rejects when bps > 10000', async () => {
      await expect(
        escrow.connect(vault).slashSubtaskPartial(t1, n1, agent.address, 6000, challenger.address, 5000),
      ).to.be.revertedWith('Bps overflow')
    })

    it('partial slash refunds remainder to agent', async () => {
      // 20% burn, no reward, 80% refund
      await escrow.connect(vault).slashSubtaskPartial(t1, n1, agent.address, 2000, ethers.ZeroAddress, 0)
      expect(await escrow.totalSlashed()).to.equal(E('1')) // 5 * 20%
      expect(await escrow.agentBalances(agent.address)).to.equal(E('9')) // 5 (unstaked) + 4 (refund)
    })
  })

  describe('settlement', () => {
    const t1 = TASK('task-settle')

    beforeEach(async () => {
      await escrow.connect(operator).createTaskFor(t1, E('20'), agent.address)
    })

    it('settle distributes equal share + refunds task-level stake', async () => {
      // Set up two winners, each with 1 ETH stake at task-level
      await escrow.connect(operator).creditAgent(agent.address, E('1'))
      await escrow.connect(operator).creditAgent(otherAgent.address, E('1'))
      await escrow.connect(agent).stake(t1, E('1'))
      await escrow.connect(otherAgent).stake(t1, E('1'))

      await expect(escrow.connect(registry).settle(t1, [agent.address, otherAgent.address]))
        .to.emit(escrow, 'Settled')

      // 20 budget / 2 = 10 each, plus 1 stake refunded each
      expect(await escrow.agentBalances(agent.address)).to.equal(E('11'))
      expect(await escrow.agentBalances(otherAgent.address)).to.equal(E('11'))

      const task = await escrow.tasks(t1)
      expect(task.finalized).to.equal(true)
    })

    it('settleWithAmounts respects per-winner amounts', async () => {
      await escrow.connect(registry).settleWithAmounts(t1, [agent.address, otherAgent.address], [E('5'), E('15')])
      expect(await escrow.agentBalances(agent.address)).to.equal(E('5'))
      expect(await escrow.agentBalances(otherAgent.address)).to.equal(E('15'))
    })

    it('settleWithAmounts rejects total > budget', async () => {
      await expect(
        escrow.connect(registry).settleWithAmounts(t1, [agent.address, otherAgent.address], [E('15'), E('15')]),
      ).to.be.revertedWith('Exceeds budget')
    })

    it('settle gated by registry', async () => {
      await expect(escrow.connect(operator).settle(t1, [agent.address]))
        .to.be.revertedWith('Caller is not the registry')
    })
  })
})
