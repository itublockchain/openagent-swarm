// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

interface ISwarmEscrowForTreasury {
    function createTaskFor(bytes32 taskId, uint256 budget, address taskOwner) external;
}

/**
 * @title SwarmTreasury
 * @notice Holds pre-funded user balances for the SDK's API-key flow. Users
 *         deposit USDC, bind their API keys on-chain, and an off-chain
 *         operator (the API service) spends against those balances when SDK
 *         calls come in. Withdrawals are always user-callable and never gated
 *         by the operator, owner, or pause — funds are custodial in code only,
 *         not in trust.
 *
 * @dev Trust model:
 *      - Operator can spend up to (a) `balanceOf[user]` and
 *        (b) `dailyCap[user]` per 24h sliding window. Both bounds are
 *        enforced on-chain — no off-chain ledger.
 *      - Users can pull their balance at any time via `withdraw`, freeze
 *        a leaked key via `freezeKey`, or pause spending across all keys
 *        by setting `dailyCap = dust`.
 *      - Owner (initial deployer; multisig in prod) can rotate the
 *        operator EOA and pause spending in emergencies. Owner CANNOT
 *        block withdrawals.
 *
 *      The contract approves Escrow ad-hoc per spend (`forceApprove`) and
 *      calls `createTaskFor`, which credits the on-chain task to the
 *      user — not to the Treasury — so existing settlement / refund logic
 *      sees the right owner without modification.
 */
contract SwarmTreasury is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    ISwarmEscrowForTreasury public immutable escrow;

    /// EOA / multisig allowed to call `spendOnBehalfOf`. Rotatable via owner.
    address public operator;

    /// User USDC balances spendable through the operator.
    mapping(address => uint256) public balanceOf;

    /// Per-key freeze flag. Set by the key's bound owner; respected on spend.
    mapping(bytes32 => bool) public frozenKey;

    /// keyHash → owning user. Set once via `bindKey`. Prevents anyone but
    /// the binding user from freezing a hash they happen to know.
    mapping(bytes32 => address) public keyOwner;

    /// Per-user 24h sliding spend cap. 0 = unlimited (operator can spend up
    /// to the user's full balance). Users SHOULD set this to bound the blast
    /// radius if a key leaks.
    mapping(address => uint256) public dailyCap;
    mapping(address => uint256) public dailyWindowStart;
    mapping(address => uint256) public dailySpent;

    uint256 public constant DAILY_WINDOW = 1 days;

    event Deposited(address indexed user, uint256 amount, uint256 newBalance);
    event Withdrew(address indexed user, uint256 amount, uint256 newBalance);
    event SpentOnBehalf(address indexed user, bytes32 indexed taskId, uint256 amount, bytes32 indexed keyHash);
    event KeyBound(bytes32 indexed keyHash, address indexed owner);
    event KeyFrozen(bytes32 indexed keyHash);
    event KeyUnfrozen(bytes32 indexed keyHash);
    event DailyCapSet(address indexed user, uint256 cap);
    event OperatorChanged(address indexed prevOperator, address indexed newOperator);

    modifier onlyOperator() {
        require(msg.sender == operator, "not operator");
        _;
    }

    constructor(address _usdc, address _escrow, address _operator) Ownable(msg.sender) {
        require(_usdc != address(0), "usdc=0");
        require(_escrow != address(0), "escrow=0");
        require(_operator != address(0), "operator=0");
        usdc = IERC20(_usdc);
        escrow = ISwarmEscrowForTreasury(_escrow);
        operator = _operator;
        emit OperatorChanged(address(0), _operator);
    }

    // ============================================================
    // User-callable — never gated by operator, owner, or pause
    // ============================================================

    function deposit(uint256 amount) external nonReentrant {
        require(amount > 0, "zero amount");
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        balanceOf[msg.sender] += amount;
        emit Deposited(msg.sender, amount, balanceOf[msg.sender]);
    }

    /// @notice Pull USDC back to the user. Never paused — custodial exit
    ///         must always be available.
    function withdraw(uint256 amount) external nonReentrant {
        require(amount > 0, "zero amount");
        uint256 bal = balanceOf[msg.sender];
        require(bal >= amount, "insufficient balance");
        balanceOf[msg.sender] = bal - amount;
        usdc.safeTransfer(msg.sender, amount);
        emit Withdrew(msg.sender, amount, balanceOf[msg.sender]);
    }

    function setDailyCap(uint256 cap) external {
        dailyCap[msg.sender] = cap;
        emit DailyCapSet(msg.sender, cap);
    }

    /// @notice One-shot bind of a keyHash to msg.sender. After this, only
    ///         the bound user can freeze/unfreeze that key. Does not store
    ///         the plaintext key — only its hash.
    function bindKey(bytes32 keyHash) external {
        require(keyHash != bytes32(0), "key=0");
        require(keyOwner[keyHash] == address(0), "already bound");
        keyOwner[keyHash] = msg.sender;
        emit KeyBound(keyHash, msg.sender);
    }

    function freezeKey(bytes32 keyHash) external {
        require(keyOwner[keyHash] == msg.sender, "not your key");
        frozenKey[keyHash] = true;
        emit KeyFrozen(keyHash);
    }

    function unfreezeKey(bytes32 keyHash) external {
        require(keyOwner[keyHash] == msg.sender, "not your key");
        frozenKey[keyHash] = false;
        emit KeyUnfrozen(keyHash);
    }

    // ============================================================
    // Operator — spends user balances against the Escrow
    // ============================================================

    function spendOnBehalfOf(
        address user,
        bytes32 taskId,
        uint256 amount,
        bytes32 keyHash
    ) external onlyOperator nonReentrant whenNotPaused {
        require(amount > 0, "zero amount");
        require(!frozenKey[keyHash], "key frozen");
        require(keyOwner[keyHash] == user, "key/user mismatch");
        uint256 bal = balanceOf[user];
        require(bal >= amount, "insufficient balance");

        // Sliding 24h window. If the previous window expired, reset
        // counter; otherwise enforce the cap inside the active window.
        uint256 windowStart = dailyWindowStart[user];
        uint256 spentInWindow = dailySpent[user];
        if (block.timestamp >= windowStart + DAILY_WINDOW) {
            windowStart = block.timestamp;
            spentInWindow = 0;
        }
        uint256 cap = dailyCap[user];
        if (cap > 0) {
            require(spentInWindow + amount <= cap, "daily cap reached");
        }
        dailyWindowStart[user] = windowStart;
        dailySpent[user] = spentInWindow + amount;

        balanceOf[user] = bal - amount;

        // Approve + call Escrow. forceApprove zeros any stale allowance
        // first, surviving the USDT-style "approve from non-zero" revert
        // on tokens that enforce it.
        usdc.forceApprove(address(escrow), amount);
        escrow.createTaskFor(taskId, amount, user);

        emit SpentOnBehalf(user, taskId, amount, keyHash);
    }

    // ============================================================
    // Owner — operator rotation + emergency pause
    // ============================================================

    function setOperator(address newOperator) external onlyOwner {
        require(newOperator != address(0), "operator=0");
        emit OperatorChanged(operator, newOperator);
        operator = newOperator;
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ============================================================
    // View helpers
    // ============================================================

    /// Returns (effectiveSpent, effectiveWindowStart) accounting for the
    /// case where the on-chain window has expired but no spend has rolled
    /// it yet — useful for off-chain UI showing "daily spent" without
    /// triggering a state-change tx.
    function dailySpentView(address user) external view returns (uint256 spent, uint256 windowStart) {
        windowStart = dailyWindowStart[user];
        if (block.timestamp >= windowStart + DAILY_WINDOW) {
            return (0, block.timestamp);
        }
        return (dailySpent[user], windowStart);
    }
}
