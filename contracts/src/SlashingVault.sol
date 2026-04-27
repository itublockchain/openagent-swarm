// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

interface ISwarmEscrow {
    function slash(bytes32 taskId, address agent) external;
    function slashPartial(
        bytes32 taskId,
        address agent,
        uint256 slashBps,
        address rewardTo,
        uint256 rewardBps
    ) external;
    function slashSubtaskPartial(
        bytes32 taskId,
        bytes32 nodeId,
        address agent,
        uint256 slashBps,
        address rewardTo,
        uint256 rewardBps
    ) external;
}

interface IDAGRegistry {
    function nodes(bytes32 nodeId) external view returns (bytes32 nodeId_, bytes32 taskId_, address claimedBy_, bytes32 outputHash_, bool validated_);
    function resetNode(bytes32 nodeId) external; 
}

/**
 * @title SlashingVault
 * @dev Handles challenges and agent slashing.
 */
contract SlashingVault is Ownable {
    struct Challenge {
        bytes32 nodeId;
        // The challenger's own subtask. 0x0 means the challenger is the
        // planner (whose stake lives at task-level, not subtask-level).
        bytes32 challengerNodeId;
        address challenger;
        address accused;
        uint256 timestamp;
        bool resolved;
    }

    uint256 public constant CHALLENGE_WINDOW = 1 hours;

    // Slashing economics, in basis points (1/10000).
    uint256 public constant ACCUSED_BURN_BPS = 8000;          // 80% burned when guilty
    uint256 public constant CHALLENGER_REWARD_BPS = 2000;     // 20% bounty to honest challenger
    uint256 public constant FALSE_CHALLENGER_BURN_BPS = 2000; // 20% burned from false challenger

    ISwarmEscrow public immutable escrow;
    IDAGRegistry public immutable registry;

    mapping(bytes32 => Challenge) public challenges;

    event ChallengeRaised(bytes32 indexed nodeId, address indexed challenger, address indexed accused);
    event SlashExecuted(bytes32 indexed nodeId, address indexed accused);
    event FalseChallenge(bytes32 indexed nodeId, address indexed challenger);

    constructor(address _escrow, address _registry) Ownable(msg.sender) {
        escrow = ISwarmEscrow(_escrow);
        registry = IDAGRegistry(_registry);
    }

    function challenge(bytes32 nodeId, address accused, bytes32 challengerNodeId) external {
        require(challenges[nodeId].timestamp == 0, "Challenge exists");
        require(accused != address(0), "Invalid accused");

        challenges[nodeId] = Challenge({
            nodeId: nodeId,
            challengerNodeId: challengerNodeId,
            challenger: msg.sender,
            accused: accused,
            timestamp: block.timestamp,
            resolved: false
        });

        emit ChallengeRaised(nodeId, msg.sender, accused);
    }

    function resolveChallenge(bytes32 nodeId, bool accusedGuilty) external onlyOwner {
        Challenge storage ch = challenges[nodeId];
        require(ch.timestamp != 0, "No challenge");
        require(!ch.resolved, "Already resolved");
        require(block.timestamp <= ch.timestamp + CHALLENGE_WINDOW, "Window expired");

        (, bytes32 taskId, , , ) = registry.nodes(nodeId);

        if (accusedGuilty) {
            // Accused worker: 80% of their subtask stake burned, 20% paid to
            // the honest challenger as bounty.
            escrow.slashSubtaskPartial(
                taskId,
                nodeId,
                ch.accused,
                ACCUSED_BURN_BPS,
                ch.challenger,
                CHALLENGER_REWARD_BPS
            );
            registry.resetNode(nodeId);
            emit SlashExecuted(nodeId, ch.accused);
        } else {
            // False challenger: slash 20% of *their* stake. If the challenger
            // is a worker, slash the subtask stake they have on their own
            // node; if they're the planner (no subtask), fall back to the
            // task-level stake.
            if (ch.challengerNodeId != bytes32(0)) {
                escrow.slashSubtaskPartial(
                    taskId,
                    ch.challengerNodeId,
                    ch.challenger,
                    FALSE_CHALLENGER_BURN_BPS,
                    address(0),
                    0
                );
            } else {
                escrow.slashPartial(
                    taskId,
                    ch.challenger,
                    FALSE_CHALLENGER_BURN_BPS,
                    address(0),
                    0
                );
            }
            emit FalseChallenge(nodeId, ch.challenger);
        }

        ch.resolved = true;
    }
}
