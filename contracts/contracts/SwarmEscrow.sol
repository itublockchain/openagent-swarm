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

    mapping(bytes32 => Task) public tasks;
    mapping(bytes32 => mapping(address => uint256)) public stakes;

    event Staked(bytes32 indexed taskId, address indexed agent, uint256 amount);
    event Settled(bytes32 indexed taskId, address[] winners);
    event Slashed(bytes32 indexed taskId, address indexed agent, uint256 amount);
    event TaskCreated(bytes32 indexed taskId, address indexed owner, uint256 budget);

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

    function setAuthorities(address _registry, address _vault) external {
        // In prod, this would be onlyOwner
        registry = _registry;
        vault = _vault;
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

    function stake(bytes32 taskId, uint256 amount) external nonReentrant notFinalized(taskId) {
        require(amount > 0, "Stake must be greater than zero");

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        stakes[taskId][msg.sender] += amount;
        tasks[taskId].stakedTotal += amount;

        emit Staked(taskId, msg.sender, amount);
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

    function slash(bytes32 taskId, address agent) external onlyVault nonReentrant notFinalized(taskId) {
        uint256 amount = stakes[taskId][agent];
        require(amount > 0, "No stake to slash");

        stakes[taskId][agent] = 0;
        tasks[taskId].stakedTotal -= amount;

        usdc.safeTransfer(address(0x000000000000000000000000000000000000dEaD), amount);

        emit Slashed(taskId, agent, amount);
    }
}
