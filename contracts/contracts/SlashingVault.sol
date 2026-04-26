// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

interface ISwarmEscrow {
    function slash(bytes32 taskId, address agent) external;
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
        address challenger;
        address accused;
        uint256 timestamp;
        bool resolved;
    }

    uint256 public constant CHALLENGE_WINDOW = 1 hours;

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

    function challenge(bytes32 nodeId, address accused) external {
        require(challenges[nodeId].timestamp == 0, "Challenge exists");
        require(accused != address(0), "Invalid accused");

        challenges[nodeId] = Challenge({
            nodeId: nodeId,
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
            escrow.slash(taskId, ch.accused);
            registry.resetNode(nodeId);
            emit SlashExecuted(nodeId, ch.accused);
        } else {
            // Penalize the false challenger
            escrow.slash(taskId, ch.challenger);
            emit FalseChallenge(nodeId, ch.challenger);
        }

        ch.resolved = true;
    }
}
