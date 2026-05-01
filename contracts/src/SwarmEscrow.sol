// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title SwarmEscrow
 * @dev Manages USDC deposits for tasks, agent staking, and reward distribution/slashing.
 */
contract SwarmEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Task {
        address owner;
        uint256 budget;
        uint256 stakedTotal;
        bool finalized;
    }

    IERC20 public immutable usdc;
    address public registry;
    address public vault;
    /// One-shot guard for setAuthorities. Once true, registry/vault are
    /// permanently locked to whatever was set during deployment wiring.
    bool public initialized;

    /// SwarmTreasury contract authorized to call `createTaskFor` on behalf
    /// of users with pre-funded balances. Set once via `setTreasury` and
    /// permanently locked. Optional — leaving unset disables the SDK
    /// flow but does not affect direct wallet-signed `createTask`.
    address public treasury;
    bool public treasuryInitialized;

    mapping(bytes32 => Task) public tasks;
    mapping(bytes32 => mapping(address => uint256)) public stakes;

    // taskId => nodeId => agent => amount. Only one staker per (task,node).
    mapping(bytes32 => mapping(bytes32 => mapping(address => uint256))) public subtaskStakes;
    // taskId => nodeId => the agent who currently has a stake locked here.
    mapping(bytes32 => mapping(bytes32 => address)) public subtaskStakeOwners;

    event Staked(bytes32 indexed taskId, address indexed agent, uint256 amount);
    event Settled(bytes32 indexed taskId, address[] winners);
    event Slashed(bytes32 indexed taskId, address indexed agent, uint256 amount);
    event TaskCreated(bytes32 indexed taskId, address indexed owner, uint256 budget);
    event SubtaskStaked(bytes32 indexed taskId, bytes32 indexed nodeId, address indexed agent, uint256 amount);
    event SubtaskStakeReleased(bytes32 indexed taskId, bytes32 indexed nodeId, address indexed agent, uint256 amount);
    event TreasurySet(address indexed treasury);

    modifier onlyRegistry() {
        require(registry != address(0) && msg.sender == registry, "Caller is not the registry");
        _;
    }

    modifier onlyVault() {
        require(vault != address(0) && msg.sender == vault, "Caller is not the vault");
        _;
    }

    modifier notFinalized(bytes32 taskId) {
        require(tasks[taskId].owner != address(0), "Task does not exist");
        require(!tasks[taskId].finalized, "Task already finalized");
        _;
    }

    constructor(address _usdc) {
        require(_usdc != address(0), "Invalid USDC address");
        usdc = IERC20(_usdc);
    }

    /// One-shot wiring: deploy script calls this once after contract creation
    /// to bind registry + vault. Any later attempt reverts. Cleaner than
    /// onlyOwner for our setup since these addresses never legitimately change
    /// after wiring — and a permanently locked binding closes the
    /// "anyone can hijack the vault" attack surface that the previous
    /// permissionless setter had.
    function setAuthorities(address _registry, address _vault) external {
        require(!initialized, "Already initialized");
        require(_registry != address(0) && _vault != address(0), "Zero address");
        registry = _registry;
        vault = _vault;
        initialized = true;
    }

    function createTask(bytes32 taskId, uint256 budget) external nonReentrant {
        require(tasks[taskId].owner == address(0), "Task already exists");
        require(budget > 0, "Budget must be greater than zero");

        usdc.safeTransferFrom(msg.sender, address(this), budget);

        tasks[taskId] = Task({
            owner: msg.sender,
            budget: budget,
            stakedTotal: 0,
            finalized: false
        });

        emit TaskCreated(taskId, msg.sender, budget);
    }

    /// One-shot wiring for the SDK Treasury. Once set, `createTaskFor` only
    /// accepts calls from `treasury`. Permanent — same posture as
    /// `setAuthorities` to close the "anyone can hijack the treasury hook"
    /// surface.
    function setTreasury(address _treasury) external {
        require(!treasuryInitialized, "Treasury already set");
        require(_treasury != address(0), "Zero address");
        treasury = _treasury;
        treasuryInitialized = true;
        emit TreasurySet(_treasury);
    }

    /// Treasury-only entry point. Pulls `budget` USDC from the Treasury
    /// (which must have approved this contract) and credits the task to
    /// `taskOwner` so existing settlement / refund logic sees the SDK
    /// caller as the on-chain owner — not the Treasury contract itself.
    function createTaskFor(bytes32 taskId, uint256 budget, address taskOwner)
        external
        nonReentrant
    {
        require(treasury != address(0) && msg.sender == treasury, "Only treasury");
        require(taskOwner != address(0), "Zero owner");
        require(tasks[taskId].owner == address(0), "Task already exists");
        require(budget > 0, "Budget must be greater than zero");

        usdc.safeTransferFrom(msg.sender, address(this), budget);

        tasks[taskId] = Task({
            owner: taskOwner,
            budget: budget,
            stakedTotal: 0,
            finalized: false
        });

        emit TaskCreated(taskId, taskOwner, budget);
    }

    function stake(bytes32 taskId, uint256 amount) external nonReentrant notFinalized(taskId) {
        require(amount > 0, "Stake must be greater than zero");

        usdc.safeTransferFrom(msg.sender, address(this), amount);

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

        usdc.safeTransferFrom(msg.sender, address(this), amount);

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

        usdc.safeTransfer(owner, amount);
        emit SubtaskStakeReleased(taskId, nodeId, owner, amount);
    }

    /// Subtask-level partial slash. Burns slashBps/10000 of the subtask
    /// stake, transfers rewardBps/10000 to rewardTo, refunds the rest.
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
            usdc.safeTransfer(address(0x000000000000000000000000000000000000dEaD), burnAmt);
        }
        if (rewardAmt > 0 && rewardTo != address(0)) {
            usdc.safeTransfer(rewardTo, rewardAmt);
        }
        if (returnAmt > 0) {
            usdc.safeTransfer(agent, returnAmt);
        }

        emit Slashed(taskId, agent, burnAmt + rewardAmt);
    }

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
                usdc.safeTransfer(winner, totalPayout);
            }
        }

        task.finalized = true;
        emit Settled(taskId, winners);
    }

    /// Explicit per-recipient settlement. The caller (registry) is expected to
    /// have already authorized this distribution (e.g. via planner gate).
    /// Each amount is the reward portion only; the agent's existing stake on the
    /// task is added on top and refunded together. Sum of amounts must not
    /// exceed the task budget; any remainder stays in escrow.
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
                usdc.safeTransfer(winner, totalPayout);
            }
        }

        task.finalized = true;
        emit Settled(taskId, winners);
    }

    function slash(bytes32 taskId, address agent) external onlyVault nonReentrant notFinalized(taskId) {
        uint256 amount = stakes[taskId][agent];
        require(amount > 0, "No stake to slash");

        stakes[taskId][agent] = 0;
        tasks[taskId].stakedTotal -= amount;

        usdc.safeTransfer(address(0x000000000000000000000000000000000000dEaD), amount);

        emit Slashed(taskId, agent, amount);
    }

    /// Partial-slash variant: burns `slashBps`/10000 of the agent's stake,
    /// transfers `rewardBps`/10000 to `rewardTo` (e.g. the honest challenger),
    /// and refunds the remainder to the agent. slashBps + rewardBps <= 10000.
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
            usdc.safeTransfer(address(0x000000000000000000000000000000000000dEaD), burnAmt);
        }
        if (rewardAmt > 0 && rewardTo != address(0)) {
            usdc.safeTransfer(rewardTo, rewardAmt);
        }
        if (returnAmt > 0) {
            usdc.safeTransfer(agent, returnAmt);
        }

        emit Slashed(taskId, agent, burnAmt + rewardAmt);
    }
}
