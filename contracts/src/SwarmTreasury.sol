// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

interface ISwarmEscrowForTreasury {
    function createTaskFor(bytes32 taskId, uint256 budget, address taskOwner) external;
}

/**
 * @title SwarmTreasury
 * @notice Tokenless credit ledger for user balances. Real USDC custody
 *         lives on Base Sepolia in the USDCGateway contract; the API
 *         operator bridges deposits/withdrawals between Base and 0G by
 *         calling `creditBalance` (after seeing a Base deposit) and
 *         `debitBalance` (before releasing on Base).
 *
 * @dev Trust model:
 *      - The operator can credit/debit any user balance, and can spend
 *        a user's balance against the Escrow via `spendOnBehalfOf`. The
 *        operator's authority is bounded only by the user's current
 *        balance — no on-chain spending caps.
 *      - Withdrawals are off-chain (operator-driven) because real USDC
 *        custody is on Base. Users cannot pull funds out of this
 *        contract directly — the matching `release` happens on
 *        USDCGateway via the API's `/v1/withdraw` flow.
 *      - Owner (deployer; multisig in prod) can rotate the operator EOA
 *        and pause spending in emergencies.
 */
contract SwarmTreasury is Ownable, ReentrancyGuard, Pausable {
    ISwarmEscrowForTreasury public immutable escrow;

    /// EOA / multisig allowed to call credit/debit/spendOnBehalfOf.
    /// Rotatable via owner.
    address public operator;

    /// Per-user spendable balance. Source of truth: the operator's
    /// BridgeWatcher service mirrors USDCGateway.Deposited events here.
    mapping(address => uint256) public balanceOf;

    event Credited(address indexed user, uint256 amount, uint256 newBalance);
    event Debited(address indexed user, uint256 amount, uint256 newBalance);
    event SpentOnBehalf(address indexed user, bytes32 indexed taskId, uint256 amount);
    event OperatorChanged(address indexed prevOperator, address indexed newOperator);

    modifier onlyOperator() {
        require(msg.sender == operator, "not operator");
        _;
    }

    constructor(address _escrow, address _operator) Ownable(msg.sender) {
        require(_escrow != address(0), "escrow=0");
        require(_operator != address(0), "operator=0");
        escrow = ISwarmEscrowForTreasury(_escrow);
        operator = _operator;
        emit OperatorChanged(address(0), _operator);
    }

    // ============================================================
    // Operator-only credit/debit (bridge from Base)
    // ============================================================

    /// Credit a user's balance after a confirmed deposit on Base. Callers
    /// must guarantee idempotency at the bridge layer — this function has
    /// no on-chain dedupe of Base events.
    function creditBalance(address user, uint256 amount) external onlyOperator nonReentrant {
        require(user != address(0), "user=0");
        require(amount > 0, "zero amount");
        balanceOf[user] += amount;
        emit Credited(user, amount, balanceOf[user]);
    }

    /// Debit a user's balance before releasing real USDC on Base. The
    /// operator should only release on Base AFTER this debit confirms,
    /// and a release tx is matched to a debit tx by request id off-chain.
    function debitBalance(address user, uint256 amount) external onlyOperator nonReentrant {
        require(amount > 0, "zero amount");
        uint256 bal = balanceOf[user];
        require(bal >= amount, "insufficient balance");
        balanceOf[user] = bal - amount;
        emit Debited(user, amount, balanceOf[user]);
    }

    // ============================================================
    // Operator — spends user balances against the Escrow
    // ============================================================

    function spendOnBehalfOf(
        address user,
        bytes32 taskId,
        uint256 amount
    ) external onlyOperator nonReentrant whenNotPaused {
        require(user != address(0), "user=0");
        require(amount > 0, "zero amount");
        uint256 bal = balanceOf[user];
        require(bal >= amount, "insufficient balance");

        balanceOf[user] = bal - amount;

        // Tokenless escrow records `taskOwner` as the credited owner; no
        // ERC20 transfer happens — the Treasury debit IS the payment.
        escrow.createTaskFor(taskId, amount, user);

        emit SpentOnBehalf(user, taskId, amount);
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
}
