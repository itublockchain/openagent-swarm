import { expect } from 'chai'
import { ethers } from 'hardhat'
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers'

const ETH_SEP_DOMAIN = 0
const ARB_SEP_DOMAIN = 3
const BASE_SEP_DOMAIN = 6

function addressToBytes32(addr: string): string {
  return '0x' + '0'.repeat(24) + addr.slice(2).toLowerCase()
}

/**
 * Build a full V2 message envelope (outer header + inner burn body),
 * matching Circle's MessageV2.sol + BurnMessageV2.sol layouts.
 *
 *   outer:  version | srcDomain | dstDomain | nonce | sender | recipient |
 *           destinationCaller | minFinality | finalityExecuted | body
 *   body:   version | burnToken | mintRecipient | amount | messageSender |
 *           maxFee | feeExecuted | expirationBlock | hookData
 */
function buildMessage(opts: {
  srcDomain: number
  dstDomain?: number
  nonce?: string
  envelopeSender: string  // source-chain TokenMessengerV2 (bytes32)
  envelopeRecipient?: string // destination TokenMessengerV2 (bytes32)
  destinationCaller?: string
  minFinalityThreshold?: number
  finalityThresholdExecuted?: number
  burnToken: string
  mintRecipient: string
  amount: bigint
  messageSender: string
  maxFee?: bigint
  feeExecuted?: bigint
  expirationBlock?: bigint
  hookData?: string
}): string {
  const body = ethers.solidityPacked(
    ['uint32', 'bytes32', 'bytes32', 'uint256', 'bytes32', 'uint256', 'uint256', 'uint256', 'bytes'],
    [
      1,
      addressToBytes32(opts.burnToken),
      addressToBytes32(opts.mintRecipient),
      opts.amount,
      addressToBytes32(opts.messageSender),
      opts.maxFee ?? 0n,
      opts.feeExecuted ?? 0n,
      opts.expirationBlock ?? 0n,
      opts.hookData ?? '0x',
    ],
  )

  const envelope = ethers.solidityPacked(
    ['uint32', 'uint32', 'uint32', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'uint32', 'uint32', 'bytes'],
    [
      1,
      opts.srcDomain,
      opts.dstDomain ?? BASE_SEP_DOMAIN,
      opts.nonce ?? '0x' + '00'.repeat(32),
      opts.envelopeSender,
      opts.envelopeRecipient ?? addressToBytes32('0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA'),
      opts.destinationCaller ?? '0x' + '00'.repeat(32),
      opts.minFinalityThreshold ?? 1000,
      opts.finalityThresholdExecuted ?? 1000,
      body,
    ],
  )

  return envelope
}

describe('CCTPDepositReceiver', () => {
  let usdc: any
  let gateway: any
  let receiver: any
  let owner: SignerWithAddress
  let deployer: SignerWithAddress
  let transmitter: SignerWithAddress
  let user: SignerWithAddress
  let other: SignerWithAddress

  const ETH_SEP_TM = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA'
  const ETH_SEP_TM_B32 = addressToBytes32(ETH_SEP_TM)
  const ARB_SEP_TM = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA'
  const ARB_SEP_TM_B32 = addressToBytes32(ARB_SEP_TM)

  beforeEach(async () => {
    ;[deployer, owner, transmitter, user, other] = await ethers.getSigners()

    const MockERC20 = await ethers.getContractFactory('MockERC20')
    usdc = await MockERC20.deploy('USD Coin', 'USDC', 6)
    await usdc.waitForDeployment()

    const Gateway = await ethers.getContractFactory('USDCGateway')
    gateway = await Gateway.deploy(await usdc.getAddress(), deployer.address)
    await gateway.waitForDeployment()

    const Receiver = await ethers.getContractFactory('CCTPDepositReceiver')
    receiver = await Receiver.deploy(
      await usdc.getAddress(),
      await gateway.getAddress(),
      transmitter.address,
      owner.address,
    )
    await receiver.waitForDeployment()

    await receiver.connect(owner).setSrcTokenMessenger(ETH_SEP_DOMAIN, ETH_SEP_TM_B32)
    await receiver.connect(owner).setSrcTokenMessenger(ARB_SEP_DOMAIN, ARB_SEP_TM_B32)
  })

  // ----------------------------------------------------------------
  describe('settle — happy path', () => {
    const AMOUNT = 10_000_000n // 10 USDC
    const FEE = 1_000n
    const NET = AMOUNT - FEE

    beforeEach(async () => {
      // Simulate the CCTP V2 mint: only NET arrives at the receiver.
      await usdc.mint(await receiver.getAddress(), NET)
    })

    it('forwards USDC + emits Deposited(user, net)', async () => {
      const msg = buildMessage({
        srcDomain: ETH_SEP_DOMAIN,
        envelopeSender: ETH_SEP_TM_B32,
        burnToken: await usdc.getAddress(),
        mintRecipient: await receiver.getAddress(),
        amount: AMOUNT,
        messageSender: user.address,
        feeExecuted: FEE,
      })

      await expect(receiver.connect(other).settle(msg))
        .to.emit(receiver, 'Deposited')
        .withArgs(user.address, NET)
        .and.to.emit(receiver, 'CCTPDepositReceived')
        .withArgs(user.address, ETH_SEP_DOMAIN, AMOUNT, FEE)

      expect(await usdc.balanceOf(await gateway.getAddress())).to.equal(NET)
      expect(await usdc.balanceOf(await receiver.getAddress())).to.equal(0n)
    })

    it('settle is permissionless (any caller works)', async () => {
      const msg = buildMessage({
        srcDomain: ARB_SEP_DOMAIN,
        envelopeSender: ARB_SEP_TM_B32,
        burnToken: await usdc.getAddress(),
        mintRecipient: await receiver.getAddress(),
        amount: AMOUNT,
        messageSender: user.address,
        feeExecuted: FEE,
      })
      await expect(receiver.connect(user).settle(msg))
        .to.emit(receiver, 'Deposited')
        .withArgs(user.address, NET)
    })

    it('zero-fee path emits gross == net', async () => {
      await usdc.mint(await receiver.getAddress(), FEE)
      const msg = buildMessage({
        srcDomain: ETH_SEP_DOMAIN,
        envelopeSender: ETH_SEP_TM_B32,
        burnToken: await usdc.getAddress(),
        mintRecipient: await receiver.getAddress(),
        amount: AMOUNT,
        messageSender: user.address,
        feeExecuted: 0n,
      })
      await expect(receiver.connect(other).settle(msg))
        .to.emit(receiver, 'Deposited')
        .withArgs(user.address, AMOUNT)
    })

    it('rejects double settle (idempotent)', async () => {
      const msg = buildMessage({
        srcDomain: ETH_SEP_DOMAIN,
        envelopeSender: ETH_SEP_TM_B32,
        burnToken: await usdc.getAddress(),
        mintRecipient: await receiver.getAddress(),
        amount: AMOUNT,
        messageSender: user.address,
        feeExecuted: FEE,
      })
      await receiver.connect(other).settle(msg)
      await expect(receiver.connect(other).settle(msg)).to.be.revertedWith('already settled')
    })
  })

  // ----------------------------------------------------------------
  describe('settle — replay safety', () => {
    const AMOUNT = 1_000_000n

    it('rejects unknown source domain', async () => {
      await usdc.mint(await receiver.getAddress(), AMOUNT)
      const msg = buildMessage({
        srcDomain: 99,
        envelopeSender: ETH_SEP_TM_B32,
        burnToken: await usdc.getAddress(),
        mintRecipient: await receiver.getAddress(),
        amount: AMOUNT,
        messageSender: user.address,
      })
      await expect(receiver.connect(other).settle(msg)).to.be.revertedWith('domain not allowlisted')
    })

    it('rejects forged sender on a known domain', async () => {
      await usdc.mint(await receiver.getAddress(), AMOUNT)
      const msg = buildMessage({
        srcDomain: ETH_SEP_DOMAIN,
        envelopeSender: addressToBytes32('0x000000000000000000000000000000000000aaaa'),
        burnToken: await usdc.getAddress(),
        mintRecipient: await receiver.getAddress(),
        amount: AMOUNT,
        messageSender: user.address,
      })
      await expect(receiver.connect(other).settle(msg)).to.be.revertedWith('untrusted sender')
    })

    it('rejects mintRecipient that is not this contract', async () => {
      await usdc.mint(await receiver.getAddress(), AMOUNT)
      const msg = buildMessage({
        srcDomain: ETH_SEP_DOMAIN,
        envelopeSender: ETH_SEP_TM_B32,
        burnToken: await usdc.getAddress(),
        mintRecipient: other.address,
        amount: AMOUNT,
        messageSender: user.address,
      })
      await expect(receiver.connect(other).settle(msg)).to.be.revertedWith('wrong mintRecipient')
    })

    it('rejects body shorter than envelope+228', async () => {
      const truncated = '0x' + '00'.repeat(200)
      await expect(receiver.connect(other).settle(truncated)).to.be.revertedWith('message too short')
    })

    it('rejects fee greater than amount', async () => {
      await usdc.mint(await receiver.getAddress(), 1000n)
      const msg = buildMessage({
        srcDomain: ETH_SEP_DOMAIN,
        envelopeSender: ETH_SEP_TM_B32,
        burnToken: await usdc.getAddress(),
        mintRecipient: await receiver.getAddress(),
        amount: 1000n,
        messageSender: user.address,
        feeExecuted: 1500n,
      })
      await expect(receiver.connect(other).settle(msg)).to.be.revertedWith('fee > amount')
    })

    it('rejects net=0 (fee equals amount)', async () => {
      await usdc.mint(await receiver.getAddress(), 1000n)
      const msg = buildMessage({
        srcDomain: ETH_SEP_DOMAIN,
        envelopeSender: ETH_SEP_TM_B32,
        burnToken: await usdc.getAddress(),
        mintRecipient: await receiver.getAddress(),
        amount: 1000n,
        messageSender: user.address,
        feeExecuted: 1000n,
      })
      await expect(receiver.connect(other).settle(msg)).to.be.revertedWith('net=0')
    })

    it('rejects when USDC has not been minted yet', async () => {
      // Note: NO mint to receiver
      const msg = buildMessage({
        srcDomain: ETH_SEP_DOMAIN,
        envelopeSender: ETH_SEP_TM_B32,
        burnToken: await usdc.getAddress(),
        mintRecipient: await receiver.getAddress(),
        amount: AMOUNT,
        messageSender: user.address,
      })
      await expect(receiver.connect(other).settle(msg)).to.be.revertedWith('USDC not minted yet')
    })
  })

  // ----------------------------------------------------------------
  describe('owner-only admin', () => {
    it('setSrcTokenMessenger gated by owner', async () => {
      await expect(
        receiver
          .connect(other)
          .setSrcTokenMessenger(7, addressToBytes32('0x0000000000000000000000000000000000001234')),
      ).to.be.revertedWithCustomError(receiver, 'OwnableUnauthorizedAccount')
    })

    it('setSrcTokenMessenger updates allowlist + emits event', async () => {
      const newSender = addressToBytes32('0x0000000000000000000000000000000000001234')
      await expect(receiver.connect(owner).setSrcTokenMessenger(7, newSender))
        .to.emit(receiver, 'SrcTokenMessengerSet')
        .withArgs(7, newSender)
      expect(await receiver.srcTokenMessenger(7)).to.equal(newSender)
    })

    it('setSrcTokenMessenger to zero removes entry', async () => {
      await receiver.connect(owner).setSrcTokenMessenger(ETH_SEP_DOMAIN, ethers.ZeroHash)
      expect(await receiver.srcTokenMessenger(ETH_SEP_DOMAIN)).to.equal(ethers.ZeroHash)
    })

    it('rescueToken transfers a non-USDC token', async () => {
      const MockERC20 = await ethers.getContractFactory('MockERC20')
      const stray = await MockERC20.deploy('Stray', 'STRY', 18)
      await stray.waitForDeployment()
      await stray.mint(await receiver.getAddress(), 100n)

      await expect(receiver.connect(owner).rescueToken(await stray.getAddress(), other.address, 100n))
        .to.emit(receiver, 'TokenRescued')
        .withArgs(await stray.getAddress(), other.address, 100n)
      expect(await stray.balanceOf(other.address)).to.equal(100n)
    })

    it('rescueToken can rescue stuck USDC (admin recovery)', async () => {
      await usdc.mint(await receiver.getAddress(), 5n)
      await expect(
        receiver.connect(owner).rescueToken(await usdc.getAddress(), other.address, 5n),
      )
        .to.emit(receiver, 'TokenRescued')
        .withArgs(await usdc.getAddress(), other.address, 5n)
      expect(await usdc.balanceOf(other.address)).to.equal(5n)
    })

    it('rescueToken gated by owner', async () => {
      await expect(
        receiver.connect(other).rescueToken(other.address, other.address, 1n),
      ).to.be.revertedWithCustomError(receiver, 'OwnableUnauthorizedAccount')
    })

    it('transferOwnership rotates owner', async () => {
      await receiver.connect(owner).transferOwnership(other.address)
      expect(await receiver.owner()).to.equal(other.address)
    })
  })
})
