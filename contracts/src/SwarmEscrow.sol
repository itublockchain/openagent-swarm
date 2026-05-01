// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title SwarmEscrow
 * @notice Tokenless ledger for task budgets, agent stakes, and reward
 *         distribution. The chain that hosts this contract (0G Galileo)
 *         has no canonical USDC, so all "USDC" amounts here are pure
 *         uint256 entries with no underlying ERC20. Real USDC custody
 *         lives off-chain on Base Sepolia (USDCGateway); the API
 *         operator bridges deposits/withdrawals between the two by
 *         calling `creditAgent` / `debitAgent` here and `creditBalance`
 *         / `debitBalance` on SwarmTreasury.
 *
 * @dev Conservation: Treasury and Escrow together form a closed ledger.
 *      A user deposit (real USDC on Base) becomes Treasury.balanceOf;
 *      `Treasury.spendOnBehalfOf` debits user balance and adds to a
 *      task budget here via `createTaskFor`; `settle` redistributes
 *      that budget into agent balances; agent balances flow back to
 *      Treasury (and ultimately to a Base withdrawal) via
 *      `debitAgent` + `Treasury.creditBalance`.
 */
contract SwarmEscrow is ReentrancyGuard {
    struct Task {
        address owner;
        uint256 budget;
        uint256 stakedTotal;
        bool finalized;
    }

    address public registry;
    address public vault;
    /// One-shot guard for setAuthorities. Once true, registry/vault are
    /// permanently locked to whatever was set during deployment wiring.
    bool public initialized;

    /// SwarmTreasury contract authorized to call `createTaskFor`.
    /// Set once via `setTreasury` and permanently locked.
    address public treasury;
    bool public treasuryInitialized;

    /// API service EOA authorized to credit/debit agent balances. This
    /// is how the backend funds an agent at deploy time and sweeps its
    /// earnings back to the user's Treasury balance when stopping it.
    /// Rotatable via `setOperator`.
    address public operator;

    mapping(bytes32 => Task) public tasks;
    mapping(bytes32 => mapping(address => uint256)) public stakes;

    // taskId => nodeId => agent => amount. Only one staker per (task,node).
    mapping(bytes32 => mapping(bytes32 => mapping(address => uint256))) public subtaskStakes;
    // taskId => nodeId => the agent who currently has a stake locked here.
    mapping(bytes32 => mapping(bytes32 => address)) public subtaskStakeOwners;

    /// Per-agent unlocked balance — the credit pool that an agent draws
    /// from when staking, and that worker rewards / refunds get added
    /// back to. Replaces the per-agent USDC token wallet of the old
    /// design. Funded by `creditAgent` (operator), drained by stake calls
    /// (agent itself), increased by settlement / slash refund / reward.
    mapping(address => uint256) public agentBalances;

    /// Cumulative slashed amount that didn't go to a reward recipient.
    /// In the tokenless model nothing is actually burned; this is just a
    /// running counter for off-chain accounting.
    uint256 public totalSlashed;

    event Staked(bytes32 indexed taskId, address indexed agent, uint256 amount);
    event Settled(bytes32 indexed taskId, address[] winners);
    event Slashed(bytes32 indexed taskId, address indexed agent, uint256 amount);
    event TaskCreated(bytes32 indexed taskId, address indexed owner, uint256 budget);
    event SubtaskStaked(bytes32 indexed taskId, bytes32 indexed nodeId, address indexed agent, uint256 amount);
    event SubtaskStakeReleased(bytes32 indexed taskId, bytes32 indexed nodeId, address indexed agent, uint256 amount);
    event TreasurySet(address indexed treasury);
    event OperatorChanged(address indexed prevOperator, address indexed newOperator);
    event AgentCredited(address indexed agent, uint256 amount, uint256 newBalance);
    event AgentDebited(address indexed agent, uint256 amount, uint256 newBalance);

    modifier onlyRegistry() {
        require(registry != address(0) && msg.sender == registry, "Caller is not the registry");
        _;
    }

    modifier onlyVault() {
        require(vault != address(0) && msg.sender == vault, "Caller is not the vault");
        _;
    }

    modifier onlyOperator() {
        require(msg.sender == operator, "not operator");
        _;
    }

    modifier notFinalized(bytes32 taskId) {
        require(tasks[taskId].owner != address(0), "Task does not exist");
        require(!tasks[taskId].finalized, "Task already finalized");
        _;
    }

    constructor(address _operator) {
        require(_operator != address(0), "operator=0");
        operator = _operator;
        emit OperatorChanged(address(0), _operator);
    }

    /// One-shot wiring: deploy script calls this once after contract creation
    /// to bind registry + vault. Any later attempt reverts.
    function setAuthorities(address _registry, address _vault) external {
        require(!initialized, "Already initialized");
        require(_registry != address(0) && _vault != address(0), "Zero address");
        registry = _registry;
        vault = _vault;
        initialized = true;
    }

    /// One-shot wiring for the SDK Treasury. Once set, `createTaskFor` only
    /// accepts calls from `treasury`. Permanent.
    function setTreasury(address _treasury) external {
        require(!treasuryInitialized, "Treasury already set");
        require(_treasury != address(0), "Zero address");
        treasury = _treasury;
        treasuryInitialized = true;
        emit TreasurySet(_treasury);
    }

    /// Owner-less operator rotation. Anyone can attempt but the modifier
    /// blocks all but the current operator. Rotation is rare; on-chain
    /// governance (multisig holding the operator key) is the audit trail.
    function setOperator(address newOperator) external onlyOperator {
        require(newOperator != address(0), "operator=0");
        emit OperatorChanged(operator, newOperator);
        operator = newOperator;
    }

    // ============================================================
    // Operator-only — agent ledger funding (replaces USDC.transfer)
    // ============================================================

    /// Credit an agent's spendable balance. Used at deploy time after the
    /// operator debits the user's Treasury balance for the same amount,
    /// and when sweeping rewards into a fresh agent that has been
    /// re-instantiated under a new ephemeral key.
    function creditAgent(address agent, uint256 amount) external onlyOperator nonReentrant {
        require(agent != address(0), "agent=0");
        require(amount > 0, "zero amount");
        agentBalances[agent] += amount;
        emit AgentCredited(agent, amount, agentBalances[agent]);
    }

    /// Drain an agent's balance — the inverse of `creditAgent`. Operator
    /// pairs this with `Treasury.creditBalance(user, amount)` to sweep
    /// agent earnings back to the user when the agent is stopped.
    function debitAgent(address agent, uint256 amount) external onlyOperator nonReentrant {
        require(amount > 0, "zero amount");
        uint256 bal = agentBalances[agent];
        require(bal >= amount, "insufficient agent balance");
        agentBalances[agent] = bal - amount;
        emit AgentDebited(agent, amount, agentBalances[agent]);
    }

    // ============================================================
    // Treasury-only task creation
    // ============================================================

    /// Treasury-only entry point. The Treasury has already debited
    /// `budget` from the user's pre-funded balance; we just record the
    /// budget on-chain so settlement / refund logic sees `taskOwner` as
    /// the on-chain owner.
    function createTaskFor(bytes32 taskId, uint256 budget, address taskOwner)
        external
        nonReentrant
    {
        require(treasury != address(0) && msg.sender == treasury, "Only treasury");
        require(taskOwner != address(0), "Zero owner");
        require(tasks[taskId].owner == address(0), "Task already exists");
        require(budget > 0, "Budget must be greater than zero");

        tasks[taskId] = Task({
            owner: taskOwner,
            budget: budget,
            stakedTotal: 0,
            finalized: false
        });

        emit TaskCreated(taskId, taskOwner, budget);
    }

    // ============================================================
    // Agent-callable staking (debits agent's own balance)
    // ============================================================

    function stake(bytes32 taskId, uint256 amount) external nonReentrant notFinalized(taskId) {
        require(amount > 0, "Stake must be greater than zero");
        require(agentBalances[msg.sender] >= amount, "insufficient balance");

        agentBalances[msg.sender] -= amount;
        stakes[taskId][msg.sender] += amount;
        tasks[taskId].stakedTotal += amount;

        emit Staked(taskId, msg.sender, amount);
    }

    /// Worker stake locked specifically against a (taskId, nodeId) subtask.
    /// Released on validation, slashed on a successful challenge.
    function stakeForSubtask(bytes32 taskId, bytes32 nodeId, uint256 amount)
        external nonReentrant notFinalized(taskId)
    {
        require(amount > 0, "Stake must be greater than zero");
        require(subtaskStakes[taskId][nodeId][msg.sender] == 0, "Already staked");
        require(subtaskStakeOwners[taskId][nodeId] == address(0), "Subtask already staked");
        require(agentBalances[msg.sender] >= amount, "insufficient balance");

        agentBalances[msg.sender] -= amount;
        subtaskStakes[taskId][nodeId][msg.sender] = amount;
        subtaskStakeOwners[taskId][nodeId] = msg.sender;
        tasks[taskId].stakedTotal += amount;

        emit SubtaskStaked(taskId, nodeId, msg.sender, amount);
    }

    /// Returns the locked stake to the original staker. Idempotent: silently
    /// no-ops if there is no stake (e.g. already released or slashed).
    function releaseSubtaskStake(bytes32 taskId, bytes32 nodeId) external onlyRegistry nonReentrant {
        address owner = subtaskStakeOwners[taskId][nodeId];
        if (owner == address(0)) return;
        uint256 amount = subtaskStakes[taskId][nodeId][owner];
        if (amount == 0) {
            subtaskStakeOwners[taskId][nodeId] = address(0);
            return;
        }

        subtaskStakes[taskId][nodeId][owner] = 0;
        subtaskStakeOwners[taskId][nodeId] = address(0);
        tasks[taskId].stakedTotal -= amount;

        agentBalances[owner] += amount;
        emit SubtaskStakeReleased(taskId, nodeId, owner, amount);
    }

    // ============================================================
    // Slashing (vault-only) — ledger arithmetic, no token burn
    // ============================================================

    /// Subtask-level partial slash. Burns slashBps/10000 of the subtask
    /// stake (added to totalSlashed sink), credits rewardBps/10000 to
    /// rewardTo's agent balance, refunds the rest to the slashed agent.
    function slashSubtaskPartial(
        bytes32 taskId,
        bytes32 nodeId,
        address agent,
        uint256 slashBps,
        address rewardTo,
        uint256 rewardBps
    ) external onlyVault nonReentrant notFinalized(taskId) {
        require(slashBps + rewardBps <= 10000, "Bps overflow");
        uint256 stakeAmt = subtaskStakes[taskId][nodeId][agent];
        require(stakeAmt > 0, "No subtask stake");

        uint256 burnAmt = (stakeAmt * slashBps) / 10000;
        uint256 rewardAmt = (stakeAmt * rewardBps) / 10000;
        uint256 returnAmt = stakeAmt - burnAmt - rewardAmt;

        subtaskStakes[taskId][nodeId][agent] = 0;
        subtaskStakeOwners[taskId][nodeId] = address(0);
        tasks[taskId].stakedTotal -= stakeAmt;

        if (burnAmt > 0) {
            totalSlashed += burnAmt;
        }
        if (rewardAmt > 0 && rewardTo != address(0)) {
            agentBalances[rewardTo] += rewardAmt;
        }
        if (returnAmt > 0) {
            agentBalances[agent] += returnAmt;
        }

        emit Slashed(taskId, agent, burnAmt + rewardAmt);
    }

    function slash(bytes32 taskId, address agent) external onlyVault nonReentrant notFinalized(taskId) {
        uint256 amount = stakes[taskId][agent];
        require(amount > 0, "No stake to slash");

        stakes[taskId][agent] = 0;
        tasks[taskId].stakedTotal -= amount;
        totalSlashed += amount;

        emit Slashed(taskId, agent, amount);
    }

    /// Partial-slash variant: burns `slashBps`/10000 of the agent's stake,
    /// credits `rewardBps`/10000 to `rewardTo`'s balance, refunds the
    /// remainder to the agent. slashBps + rewardBps <= 10000.
    function slashPartial(
        bytes32 taskId,
        address agent,
        uint256 slashBps,
        address rewardTo,
        uint256 rewardBps
    ) external onlyVault nonReentrant notFinalized(taskId) {
        require(slashBps + rewardBps <= 10000, "Bps overflow");
        uint256 stakeAmt = stakes[taskId][agent];
        require(stakeAmt > 0, "No stake to slash");

        uint256 burnAmt = (stakeAmt * slashBps) / 10000;
        uint256 rewardAmt = (stakeAmt * rewardBps) / 10000;
        uint256 returnAmt = stakeAmt - burnAmt - rewardAmt;

        stakes[taskId][agent] = 0;
        tasks[taskId].stakedTotal -= stakeAmt;

        if (burnAmt > 0) {
            totalSlashed += burnAmt;
        }
        if (rewardAmt > 0 && rewardTo != address(0)) {
            agentBalances[rewardTo] += rewardAmt;
        }
        if (returnAmt > 0) {
            agentBalances[agent] += returnAmt;
        }

        emit Slashed(taskId, agent, burnAmt + rewardAmt);
    }

    // ============================================================
    // Settlement (registry-only) — credits winners' agent balances
    // ============================================================

    function settle(bytes32 taskId, address[] calldata winners) external onlyRegistry nonReentrant notFinalized(taskId) {
        Task storage task = tasks[taskId];
        uint256 winnerCount = winners.length;
        require(winnerCount > 0, "No winners provided");

        uint256 rewardPerWinner = task.budget / winnerCount;

        for (uint256 i = 0; i < winnerCount; i++) {
            address winner = winners[i];
            uint256 agentStake = stakes[taskId][winner];
            uint256 totalPayout = agentStake + rewardPerWinner;

            if (totalPayout > 0) {
                stakes[taskId][winner] = 0;
                agentBalances[winner] += totalPayout;
            }
        }

        task.finalized = true;
        emit Settled(taskId, winners);
    }

    /// Explicit per-recipient settlement. Each amount is the reward portion
    /// only; the agent's existing stake on the task is added on top and
    /// refunded together. Sum of amounts must not exceed the task budget;
    /// any remainder stays in escrow.
    function settleWithAmounts(
        bytes32 taskId,
        address[] calldata winners,
        uint256[] calldata amounts
    ) external onlyRegistry nonReentrant notFinalized(taskId) {
        require(winners.length == amounts.length, "Length mismatch");
        require(winners.length > 0, "No winners provided");

        Task storage task = tasks[taskId];

        uint256 totalReward;
        for (uint256 i = 0; i < amounts.length; i++) {
            totalReward += amounts[i];
        }
        require(totalReward <= task.budget, "Exceeds budget");

        for (uint256 i = 0; i < winners.length; i++) {
            address winner = winners[i];
            uint256 agentStake = stakes[taskId][winner];
            uint256 totalPayout = agentStake + amounts[i];

            if (totalPayout > 0) {
                stakes[taskId][winner] = 0;
                agentBalances[winner] += totalPayout;
            }
        }

        task.finalized = true;
        emit Settled(taskId, winners);
    }
}
