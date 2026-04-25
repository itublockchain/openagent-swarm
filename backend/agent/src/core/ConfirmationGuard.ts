import { ethers } from 'ethers';

export class ConfirmationTimeoutError extends Error {
  constructor(txHash: string) {
    super(`Transaction confirmation timeout: ${txHash}`);
    this.name = 'ConfirmationTimeoutError';
  }
}

export class TransactionFailedError extends Error {
  constructor(txHash: string) {
    super(`Transaction execution failed on-chain: ${txHash}`);
    this.name = 'TransactionFailedError';
  }
}

/**
 * Ensures that agent logic only proceeds after L2 transactions are confirmed.
 */
export class ConfirmationGuard {
  constructor(
    private provider: ethers.JsonRpcProvider,
    private requiredConfirmations = Number(process.env.L2_REQUIRED_CONFIRMATIONS || 1),
    private timeoutMs = Number(process.env.L2_TX_TIMEOUT_MS || 30000)
  ) {}

  /**
   * Waits for a transaction hash to reach the required confirmation count.
   * @throws {ConfirmationTimeoutError} If the timeout is reached.
   * @throws {TransactionFailedError} If the transaction reverted.
   */
  async waitForConfirmation(txHash: string): Promise<ethers.TransactionReceipt> {
    // Note: ethers' waitForTransaction returns null if it times out
    const receipt = await this.provider.waitForTransaction(
      txHash,
      this.requiredConfirmations,
      this.timeoutMs
    );

    if (!receipt) {
      throw new ConfirmationTimeoutError(txHash);
    }

    if (receipt.status === 0) {
      throw new TransactionFailedError(txHash);
    }

    return receipt;
  }

  /**
   * Sends a transaction and waits for its confirmation in one step.
   */
  async sendAndWait(txPromise: Promise<ethers.TransactionResponse>): Promise<ethers.TransactionReceipt> {
    const tx = await txPromise;
    return this.waitForConfirmation(tx.hash);
  }
}
