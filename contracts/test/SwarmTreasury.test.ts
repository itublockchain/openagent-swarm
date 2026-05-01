import { expect } from 'chai'
import { ethers } from 'hardhat'
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers'

const KEY = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s))
const TASK = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s))
const E = (n: string) => ethers.parseEther(n)

describe('SwarmTreasury', () => {
  let usdc: any, escrow: any, treasury: any
  let owner: SignerWithAddress, operator: SignerWithAddress
  let user: SignerWithAddress, other: SignerWithAddress

  beforeEach(async () => {
    ;[owner, operator, user, other] = await ethers.getSigners()

    const ERC = await ethers.getContractFactory('MockERC20')
    usdc = await ERC.deploy('Mock USDC', 'mUSDC')
    await usdc.waitForDeployment()

    const Escrow = await ethers.getContractFactory('SwarmEscrow')
    escrow = await Escrow.deploy(await usdc.getAddress())
    await escrow.waitForDeployment()

    const Treasury = await ethers.getContractFactory('SwarmTreasury')
    treasury = await Treasury.deploy(
      await usdc.getAddress(),
      await escrow.getAddress(),
      operator.address,
    )
    await treasury.waitForDeployment()

    await escrow.setTreasury(await treasury.getAddress())

    // Pre-fund the user with mock USDC.
    await usdc.mint(user.address, E('100'))
    await usdc.connect(user).approve(await treasury.getAddress(), E('100'))
  })

  // ----------------------------------------------------------------
  describe('deposit / withdraw', () => {
    it('deposit credits balance, pulls USDC, emits event', async () => {
      await expect(treasury.connect(user).deposit(E('10')))
        .to.emit(treasury, 'Deposited')
        .withArgs(user.address, E('10'), E('10'))
      expect(await treasury.balanceOf(user.address)).to.equal(E('10'))
      expect(await usdc.balanceOf(await treasury.getAddress())).to.equal(E('10'))
    })

    it('deposit rejects zero', async () => {
      await expect(treasury.connect(user).deposit(0)).to.be.revertedWith('zero amount')
    })

    it('withdraw refunds balance', async () => {
      await treasury.connect(user).deposit(E('10'))
      await expect(treasury.connect(user).withdraw(E('4')))
        .to.emit(treasury, 'Withdrew')
        .withArgs(user.address, E('4'), E('6'))
      expect(await treasury.balanceOf(user.address)).to.equal(E('6'))
    })

    it('withdraw works even when paused — invariant: custodial exit always available', async () => {
      await treasury.connect(user).deposit(E('10'))
      await treasury.connect(owner).pause()
      await expect(treasury.connect(user).withdraw(E('10'))).to.emit(treasury, 'Withdrew')
      expect(await treasury.balanceOf(user.address)).to.equal(0n)
    })

    it('withdraw rejects over-withdraw', async () => {
      await treasury.connect(user).deposit(E('1'))
      await expect(treasury.connect(user).withdraw(E('5'))).to.be.revertedWith('insufficient balance')
    })
  })

  // ----------------------------------------------------------------
  describe('key binding + freezing', () => {
    const k = KEY('alpha')

    it('bindKey records owner, rejects re-bind', async () => {
      await expect(treasury.connect(user).bindKey(k))
        .to.emit(treasury, 'KeyBound')
        .withArgs(k, user.address)
      expect(await treasury.keyOwner(k)).to.equal(user.address)
      await expect(treasury.connect(other).bindKey(k)).to.be.revertedWith('already bound')
    })

    it('bindKey rejects zero hash', async () => {
      await expect(treasury.connect(user).bindKey(ethers.ZeroHash)).to.be.revertedWith('key=0')
    })

    it('freezeKey gated by binding', async () => {
      await treasury.connect(user).bindKey(k)
      await expect(treasury.connect(other).freezeKey(k)).to.be.revertedWith('not your key')
      await expect(treasury.connect(user).freezeKey(k)).to.emit(treasury, 'KeyFrozen')
      expect(await treasury.frozenKey(k)).to.equal(true)
    })

    it('unfreezeKey gated by binding', async () => {
      await treasury.connect(user).bindKey(k)
      await treasury.connect(user).freezeKey(k)
      await expect(treasury.connect(other).unfreezeKey(k)).to.be.revertedWith('not your key')
      await expect(treasury.connect(user).unfreezeKey(k)).to.emit(treasury, 'KeyUnfrozen')
      expect(await treasury.frozenKey(k)).to.equal(false)
    })
  })

  // ----------------------------------------------------------------
  describe('spendOnBehalfOf', () => {
    const k = KEY('spend-key')
    const t1 = TASK('task-1')

    beforeEach(async () => {
      await treasury.connect(user).deposit(E('20'))
      await treasury.connect(user).bindKey(k)
    })

    it('debits balance, calls Escrow.createTaskFor with user as owner', async () => {
      await expect(treasury.connect(operator).spendOnBehalfOf(user.address, t1, E('5'), k))
        .to.emit(treasury, 'SpentOnBehalf')
        .withArgs(user.address, t1, E('5'), k)
        .and.to.emit(escrow, 'TaskCreated')
        .withArgs(t1, user.address, E('5'))

      expect(await treasury.balanceOf(user.address)).to.equal(E('15'))
      const task = await escrow.tasks(t1)
      expect(task.owner).to.equal(user.address)
      expect(task.budget).to.equal(E('5'))
    })

    it('rejects when key is frozen', async () => {
      await treasury.connect(user).freezeKey(k)
      await expect(treasury.connect(operator).spendOnBehalfOf(user.address, t1, E('1'), k))
        .to.be.revertedWith('key frozen')
    })

    it('rejects when keyHash is bound to a different user', async () => {
      await expect(treasury.connect(operator).spendOnBehalfOf(other.address, t1, E('1'), k))
        .to.be.revertedWith('key/user mismatch')
    })

    it('rejects when balance is insufficient', async () => {
      await expect(treasury.connect(operator).spendOnBehalfOf(user.address, t1, E('999'), k))
        .to.be.revertedWith('insufficient balance')
    })

    it('rejects from non-operator', async () => {
      await expect(treasury.connect(other).spendOnBehalfOf(user.address, t1, E('1'), k))
        .to.be.revertedWith('not operator')
    })

    it('respects pause for operator path (but not withdraw)', async () => {
      await treasury.connect(owner).pause()
      await expect(treasury.connect(operator).spendOnBehalfOf(user.address, t1, E('1'), k)).to.be.reverted
    })

    it('rejects zero amount', async () => {
      await expect(treasury.connect(operator).spendOnBehalfOf(user.address, t1, 0, k))
        .to.be.revertedWith('zero amount')
    })
  })

  // ----------------------------------------------------------------
  describe('dailyCap sliding window', () => {
    const k = KEY('cap-key')
    const t1 = TASK('cap-1')
    const t2 = TASK('cap-2')
    const t3 = TASK('cap-3')

    beforeEach(async () => {
      await treasury.connect(user).deposit(E('20'))
      await treasury.connect(user).bindKey(k)
      await treasury.connect(user).setDailyCap(E('5'))
    })

    it('blocks spend that would exceed the cap', async () => {
      await treasury.connect(operator).spendOnBehalfOf(user.address, t1, E('3'), k)
      await expect(treasury.connect(operator).spendOnBehalfOf(user.address, t2, E('3'), k))
        .to.be.revertedWith('daily cap reached')
    })

    it('rolls window after 24h, allowing fresh spend', async () => {
      await treasury.connect(operator).spendOnBehalfOf(user.address, t1, E('5'), k)
      // Window expired
      await ethers.provider.send('evm_increaseTime', [86_401])
      await ethers.provider.send('evm_mine', [])
      await expect(
        treasury.connect(operator).spendOnBehalfOf(user.address, t2, E('5'), k),
      ).to.emit(treasury, 'SpentOnBehalf')
    })

    it('cap = 0 means unlimited', async () => {
      await treasury.connect(user).setDailyCap(0)
      await expect(treasury.connect(operator).spendOnBehalfOf(user.address, t1, E('20'), k))
        .to.emit(treasury, 'SpentOnBehalf')
    })

    it('dailySpentView reflects rolled window without state change', async () => {
      await treasury.connect(operator).spendOnBehalfOf(user.address, t1, E('3'), k)
      const [spent1, ws1] = await treasury.dailySpentView(user.address)
      expect(spent1).to.equal(E('3'))
      expect(ws1).to.be.gt(0n)

      await ethers.provider.send('evm_increaseTime', [86_401])
      await ethers.provider.send('evm_mine', [])
      const [spent2, ws2] = await treasury.dailySpentView(user.address)
      expect(spent2).to.equal(0n)
      expect(ws2).to.be.gt(ws1)
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
      await expect(treasury.connect(owner).setOperator(ethers.ZeroAddress)).to.be.revertedWith('operator=0')
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
      // operator is not the treasury contract itself
      await expect(
        escrow.connect(operator).createTaskFor(t1, E('1'), user.address),
      ).to.be.revertedWith('Only treasury')
    })

    it('rejects re-init of treasury', async () => {
      await expect(escrow.setTreasury(await treasury.getAddress()))
        .to.be.revertedWith('Treasury already set')
    })

    it('rejects zero owner', async () => {
      // We'd need to reach createTaskFor as the treasury contract; easiest
      // is to redeploy with treasury = a signer so we can call directly.
      const Escrow2 = await ethers.getContractFactory('SwarmEscrow')
      const escrow2 = await Escrow2.deploy(await usdc.getAddress())
      await escrow2.waitForDeployment()
      await escrow2.setTreasury(operator.address)
      await usdc.mint(operator.address, E('5'))
      await usdc.connect(operator).approve(await escrow2.getAddress(), E('5'))
      await expect(
        escrow2.connect(operator).createTaskFor(t1, E('1'), ethers.ZeroAddress),
      ).to.be.revertedWith('Zero owner')
    })
  })
})
