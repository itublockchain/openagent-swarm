// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

interface ISwarmEscrow {
    function slash(bytes32 taskId, address agent) external;
    function stakes(bytes32 taskId, address agent) external view returns (uint256);
}

interface IDAGRegistry {
    function nodes(bytes32 nodeId) external view returns (bytes32, bytes32, address, bytes32, bool);
    // Note: This assumes a resetNode function was added to Registry or handled via vault authority
    function resetNode(bytes32 nodeId) external; 
}

/**
 * @title SlashingVault
 * @dev Handles challenges, slashing malicious agents, and resetting failed tasks.
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
    uint256 public constant FALSE_CHALLENGE_PENALTY = 20; // 20%

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

    /**
     * @notice Raises a challenge against an agent's output for a specific node.
     * @param nodeId Identifier of the node being challenged.
     * @param accused Address of the agent who submitted the output.
     */
    function challenge(bytes32 nodeId, address accused) external {
        require(challenges[nodeId].timestamp == 0, "Challenge already exists for this node");
        require(accused != address(0), "Invalid accused address");

        challenges[nodeId] = Challenge({
            nodeId: nodeId,
            challenger: msg.sender,
            accused: accused,
            timestamp: block.timestamp,
            resolved: false
        });

        emit ChallengeRaised(nodeId, msg.sender, accused);
    }

    /**
     * @notice Resolves an active challenge.
     * @dev Only callable by the owner (Oracle or Governance).
     * @param nodeId Identifier of the challenged node.
     * @param accusedGuilty True if the accused agent indeed submitted wrong output.
     */
    function resolveChallenge(bytes32 nodeId, bool accusedGuilty) external onlyOwner {
        Challenge storage ch = challenges[nodeId];
        require(ch.timestamp != 0, "Challenge does not exist");
        require(!ch.resolved, "Challenge already resolved");
        require(block.timestamp <= ch.timestamp + CHALLENGE_WINDOW, "Challenge window expired");

        (,, , bytes32 taskId, ) = registry.nodes(nodeId);

        if (accusedGuilty) {
            // Slash the accused agent
            escrow.slash(taskId, ch.accused);
            
            // Reset node in registry so it can be claimed again
            registry.resetNode(nodeId);
            
            emit SlashExecuted(nodeId, ch.accused);
        } else {
            // Penalize the false challenger (simplified: logical deduction for off-chain accounting 
            // or direct slash if challenger has a specific stake map)
            emit FalseChallenge(nodeId, ch.challenger);
        }

        ch.resolved = true;
    }
}
