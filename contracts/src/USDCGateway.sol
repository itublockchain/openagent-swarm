// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title USDCGateway
 * @notice Real USDC custody on Base Sepolia. Users `deposit` here; an
 *         off-chain BridgeWatcher mirrors the resulting `Deposited`
 *         event into SwarmTreasury.balanceOf on 0G. Withdrawals are
 *         operator-only (`release`) — the API debits Treasury first,
 *         then releases real USDC here.
 *
 * @dev Idempotency: `release(user, amount, requestId)` rejects a repeat
 *      requestId. Backend builds requestId = keccak256(user, amount,
 *      nonce) so a retry of a stuck withdrawal cannot double-pay.
 *
 *      The contract is intentionally minimal — no on-chain accounting,
 *      no per-user limits, no challenge windows. Trust is custodial:
 *      the operator key controls all withdrawals. Owner can rotate
 *      operator and rescue mistakenly-sent tokens.
 *
 *      Pause: blocks `deposit` only. `release` MUST keep working under
 *      pause so the operator can drain user funds in an emergency
 *      shutdown.
 */
contract USDCGateway is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    /// Real USDC token on Base Sepolia (Circle's FiatTokenV2).
    /// Set in constructor, never rotated.
    IERC20 public immutable usdc;

    /// API service EOA authorized to release deposits back to users.
    address public operator;

    /// requestId => true once processed. Idempotency for `release`.
    mapping(bytes32 => bool) public processedRequests;

    event Deposited(address indexed user, uint256 amount);
    event Released(address indexed user, uint256 amount, bytes32 indexed requestId);
    event OperatorChanged(address indexed prevOperator, address indexed newOperator);
    event TokenRescued(address indexed token, address indexed to, uint256 amount);

    modifier onlyOperator() {
        require(msg.sender == operator, "not operator");
        _;
    }

    constructor(address _usdc, address _operator) Ownable(msg.sender) {
        require(_usdc != address(0), "usdc=0");
        require(_operator != address(0), "operator=0");
        usdc = IERC20(_usdc);
        operator = _operator;
        emit OperatorChanged(address(0), _operator);
    }

    // ============================================================
    // User-facing — deposit real USDC
    // ============================================================

    function deposit(uint256 amount) external nonReentrant whenNotPaused {
        require(amount > 0, "zero amount");
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    // ============================================================
    // Operator-only — release real USDC back to user
    // ============================================================

    /// Idempotent withdrawal. The matching debit on SwarmTreasury (0G)
    /// must have already settled — that's the API's responsibility, not
    /// enforced on-chain. `requestId` is opaque to this contract and is
    /// only used to reject duplicates.
    function release(address user, uint256 amount, bytes32 requestId)
        external
        onlyOperator
        nonReentrant
    {
        require(user != address(0), "user=0");
        require(amount > 0, "zero amount");
        require(requestId != bytes32(0), "request=0");
        require(!processedRequests[requestId], "already processed");

        processedRequests[requestId] = true;
        usdc.safeTransfer(user, amount);

        emit Released(user, amount, requestId);
    }

    // ============================================================
    // Owner — operator rotation, pause, rescue
    // ============================================================

    function setOperator(address newOperator) external onlyOwner {
        require(newOperator != address(0), "operator=0");
        emit OperatorChanged(operator, newOperator);
        operator = newOperator;
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    /// Rescue tokens accidentally sent to the contract. Excludes the
    /// configured USDC token to prevent the owner from siphoning user
    /// deposits — those must always exit through `release`.
    function rescueToken(address token, address to, uint256 amount) external onlyOwner {
        require(token != address(usdc), "use release for USDC");
        require(to != address(0), "to=0");
        IERC20(token).safeTransfer(to, amount);
        emit TokenRescued(token, to, amount);
    }
}
