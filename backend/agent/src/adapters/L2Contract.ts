import { ethers, Contract, TransactionReceipt, LogDescription } from 'ethers';
import { IChainPort } from '../../../shared/ports';
import { ConfirmationGuard } from '../core/ConfirmationGuard';
import deployments from '../../../../contracts/deployments.json';

// ABI'lar (Daha temiz olması için ana fonksiyonları buraya ekliyoruz)
const REGISTRY_ABI = [
  "function claimPlanner(bytes32 taskId) external returns (bool)",
  "function claimSubtask(bytes32 nodeId) external returns (bool)",
  "function registerDAG(bytes32 taskId, bytes32[] calldata nodeIds) external",
  "function markValidated(bytes32 nodeId) external",
  "event PlannerSelected(bytes32 indexed taskId, address indexed planner)",
  "event SubtaskClaimed(bytes32 indexed nodeId, address indexed agent)"
];

const ESCROW_ABI = [
  "function stake(bytes32 taskId, uint256 amount) external",
  "function settle(bytes32 taskId, address[] calldata winners) external"
];

const VAULT_ABI = [
  "function challenge(bytes32 nodeId, address accused) external"
];

export class L2Contract implements IChainPort {
  private provider: ethers.JsonRpcProvider;
  private wallet: ethers.Wallet;
  private registry: Contract;
  private escrow: Contract;
  private vault: Contract;
  private guard: ConfirmationGuard;

  constructor() {
    this.provider = new ethers.JsonRpcProvider(process.env.L2_RPC_URL);
    this.wallet = new ethers.Wallet(process.env.L2_PRIVATE_KEY!, this.provider);
    
    this.registry = new Contract(deployments.DAGRegistry, REGISTRY_ABI, this.wallet);
    this.escrow = new Contract(deployments.SwarmEscrow, ESCROW_ABI, this.wallet);
    this.vault = new Contract(deployments.SlashingVault, VAULT_ABI, this.wallet);
    
    this.guard = new ConfirmationGuard(this.provider);
  }

  async claimPlanner(taskId: string): Promise<boolean> {
    const tx = await this.registry.claimPlanner(this.toBytes32(taskId));
    const receipt = await this.guard.waitForConfirmation(tx.hash);
    
    const event = this.parseEventFromReceipt(receipt, this.registry, 'PlannerSelected');
    return event !== null;
  }

  async claimSubtask(nodeId: string): Promise<boolean> {
    const tx = await this.registry.claimSubtask(this.toBytes32(nodeId));
    const receipt = await this.guard.waitForConfirmation(tx.hash);
    
    const event = this.parseEventFromReceipt(receipt, this.registry, 'SubtaskClaimed');
    return event !== null;
  }

  async stake(taskId: string, amount: string): Promise<string> {
    const tx = await this.escrow.stake(this.toBytes32(taskId), ethers.parseUnits(amount, 6)); // USDC 6 decimals
    const receipt = await this.guard.waitForConfirmation(tx.hash);
    return receipt.hash;
  }

  async challenge(nodeId: string): Promise<void> {
    // Note: Accused address detection logic might be needed here, 
    // for now we use a simplified call or assume registry provides it
    const tx = await this.vault.challenge(this.toBytes32(nodeId), ethers.ZeroAddress); 
    await this.guard.waitForConfirmation(tx.hash);
  }

  async settle(taskId: string, winners: string[]): Promise<void> {
    // Note: Settle usually triggered by Registry.markValidated in our flow,
    // but port might need direct access
    const tx = await this.registry.markValidated(this.toBytes32(taskId));
    await this.guard.waitForConfirmation(tx.hash);
  }

  private parseEventFromReceipt(
    receipt: TransactionReceipt,
    contract: Contract,
    eventName: string
  ): LogDescription | null {
    for (const log of receipt.logs) {
      try {
        const parsedLog = contract.interface.parseLog(log);
        if (parsedLog && parsedLog.name === eventName) {
          return parsedLog;
        }
      } catch (e) {
        // Log could not be parsed by this contract interface, skip
        continue;
      }
    }
    return null;
  }

  private toBytes32(id: string): string {
    // If id is already a hex string of 32 bytes, return it, otherwise hash it
    return id.startsWith('0x') && id.length === 66 ? id : ethers.id(id);
  }
}
