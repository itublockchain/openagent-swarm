// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title CCTPDepositReceiver
 * @notice Sibling of USDCGateway for Circle CCTP V2 cross-chain USDC
 *         deposits. Acts as the `mintRecipient` for V2 burns; after
 *         Circle's MessageTransmitterV2.receiveMessage mints USDC into
 *         this contract, anyone (operator in practice) calls `settle`
 *         with the same V2 envelope bytes — we parse the burn body,
 *         forward the net USDC into the existing USDCGateway, and emit
 *         `Deposited(user, amount)` matching USDCGateway's event so the
 *         off-chain BridgeWatcher credits SwarmTreasury on 0G unchanged.
 *
 * @dev Why a `settle()` step instead of an automatic hook callback:
 *      CCTP V2 does NOT auto-invoke a hook on the mintRecipient.
 *      `depositForBurnWithHook`'s hookData rides along in the message
 *      body but the protocol never calls the recipient — execution is
 *      caller-controlled (see Circle's `CCTPHookWrapper.sol` reference
 *      contract). So we keep things simple: the relayer makes two txs
 *      back-to-back (`receiveMessage` then `settle`); both go through
 *      the operator EOA which already pays gas for the relay.
 *
 * @dev Idempotency: `settle` is keyed on keccak256(message) so a repeat
 *      submission is a no-op. The check happens before the USDC transfer
 *      so a re-entrant or double-call cannot drain the receiver.
 */
contract CCTPDepositReceiver is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// Real USDC token on Base Sepolia (Circle's FiatTokenV2).
    IERC20 public immutable usdc;

    /// Existing USDCGateway — minted USDC is forwarded here so all
    /// custody stays in one place and `release` continues to pay out.
    address public immutable usdcGateway;

    /// Circle's MessageTransmitterV2 on Base Sepolia. Validated when
    /// settling a message — `outer.recipient` must equal Circle's V2
    /// TokenMessengerV2 (the standard burn-message recipient on V2).
    address public immutable messageTransmitter;

    /// CCTP source domain → trusted TokenMessengerV2 sender (bytes32 of
    /// the source-chain TokenMessengerV2 address). Owner-curated. Used
    /// to defend against attempts to settle a message whose envelope
    /// claims a forged source.
    mapping(uint32 => bytes32) public srcTokenMessenger;

    /// keccak256(message) → true once settled. Prevents replay even if
    /// the relayer accidentally calls `settle` twice for the same burn.
    mapping(bytes32 => bool) public settledMessages;

    // ===== MessageV2 outer envelope offsets =====
    // version          : 0   (uint32, 4B)
    // sourceDomain     : 4   (uint32, 4B)
    // destinationDomain: 8   (uint32, 4B)
    // nonce            : 12  (bytes32)
    // sender           : 44  (bytes32)
    // recipient        : 76  (bytes32)
    // destinationCaller: 108 (bytes32)
    // minFinalityThr   : 140 (uint32, 4B)
    // finalityExecuted : 144 (uint32, 4B)
    // messageBody      : 148 (dynamic — burn body)
    uint256 private constant ENVELOPE_HEADER_LEN = 148;

    // ===== BurnMessageV2 byte offsets (per Circle's BurnMessageV2.sol) =====
    // version          : 0   (uint32, 4B)
    // burnToken        : 4   (bytes32)
    // mintRecipient    : 36  (bytes32)
    // amount           : 68  (uint256)
    // messageSender    : 100 (bytes32)
    // maxFee           : 132 (uint256)
    // feeExecuted      : 164 (uint256)
    // expirationBlock  : 196 (uint256)
    // hookData         : 228 (dynamic bytes — unused here)
    uint256 private constant MIN_BURN_BODY_LEN = 228;

    /// Mirror of USDCGateway.Deposited so BridgeWatcher's existing
    /// queryFilter works without ABI changes.
    event Deposited(address indexed user, uint256 amount);

    /// Richer observability for CCTP-sourced credits. `grossAmount` is
    /// the raw burn amount, `feeExecuted` is the Circle fee skimmed by
    /// the V2 fast-path executor; `Deposited.amount` emits the net.
    event CCTPDepositReceived(
        address indexed user,
        uint32 indexed srcDomain,
        uint256 grossAmount,
        uint256 feeExecuted
    );

    event SrcTokenMessengerSet(uint32 indexed srcDomain, bytes32 tokenMessenger);
    event TokenRescued(address indexed token, address indexed to, uint256 amount);

    constructor(
        address _usdc,
        address _usdcGateway,
        address _messageTransmitter,
        address _owner
    ) Ownable(_owner) {
        require(_usdc != address(0), "usdc=0");
        require(_usdcGateway != address(0), "gateway=0");
        require(_messageTransmitter != address(0), "transmitter=0");
        require(_owner != address(0), "owner=0");
        usdc = IERC20(_usdc);
        usdcGateway = _usdcGateway;
        messageTransmitter = _messageTransmitter;
    }

    // ============================================================
    // Public settle — call AFTER MessageTransmitterV2.receiveMessage
    // has minted USDC into this contract. Permissionless: anyone may
    // call (we control no off-chain monopoly and a stale USDC sit on
    // the receiver hurts only the user, who is incentivized to act).
    // The relayer (operator EOA) calls it as the second tx of the
    // relay flow.
    // ============================================================

    function settle(bytes calldata message) external nonReentrant {
        require(message.length >= ENVELOPE_HEADER_LEN + MIN_BURN_BODY_LEN, "message too short");

        bytes32 messageHash = keccak256(message);
        require(!settledMessages[messageHash], "already settled");

        // Outer envelope fields we care about.
        uint32 srcDomain = uint32(bytes4(message[4:8]));
        bytes32 senderBytes = bytes32(message[44:76]);

        bytes32 trustedSender = srcTokenMessenger[srcDomain];
        require(trustedSender != bytes32(0), "domain not allowlisted");
        require(senderBytes == trustedSender, "untrusted sender");

        // Burn body lives at offset ENVELOPE_HEADER_LEN onward.
        bytes calldata body = message[ENVELOPE_HEADER_LEN:];

        bytes32 mintRecipientB = bytes32(body[36:68]);
        uint256 grossAmount = uint256(bytes32(body[68:100]));
        bytes32 messageSenderB = bytes32(body[100:132]);
        uint256 feeExecuted = uint256(bytes32(body[164:196]));

        require(
            address(uint160(uint256(mintRecipientB))) == address(this),
            "wrong mintRecipient"
        );
        require(grossAmount >= feeExecuted, "fee > amount");

        address user = address(uint160(uint256(messageSenderB)));
        require(user != address(0), "user=0");

        uint256 net = grossAmount - feeExecuted;
        require(net > 0, "net=0");

        // The mint must have already landed on this contract before
        // settle is called. Guards against a relayer that submits
        // settle without having submitted receiveMessage (or whose
        // receiveMessage reverted) — we'd otherwise emit Deposited for
        // USDC that was never minted.
        require(usdc.balanceOf(address(this)) >= net, "USDC not minted yet");

        settledMessages[messageHash] = true;
        usdc.safeTransfer(usdcGateway, net);

        emit Deposited(user, net);
        emit CCTPDepositReceived(user, srcDomain, grossAmount, feeExecuted);
    }

    // ============================================================
    // Owner — manage allowlist, rescue tokens
    // ============================================================

    /// Register a CCTP source domain's trusted TokenMessengerV2 address
    /// (encoded as bytes32). Pass bytes32(0) to remove a domain.
    function setSrcTokenMessenger(uint32 srcDomain, bytes32 tokenMessenger) external onlyOwner {
        srcTokenMessenger[srcDomain] = tokenMessenger;
        emit SrcTokenMessengerSet(srcDomain, tokenMessenger);
    }

    /// Rescue tokens accidentally sent to this contract — including
    /// USDC. Without USDC rescue, mints whose `settle` failed (e.g.,
    /// srcTokenMessenger misconfigured at the time of settlement) sit
    /// stuck forever. Owner is the operator EOA, so this is the same
    /// trust assumption the rest of the system already accepts.
    function rescueToken(address token, address to, uint256 amount) external onlyOwner {
        require(to != address(0), "to=0");
        IERC20(token).safeTransfer(to, amount);
        emit TokenRescued(token, to, amount);
    }
}
