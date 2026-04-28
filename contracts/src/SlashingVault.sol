// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./AgentRegistry.sol";

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
    function nodes(bytes32 nodeId) external view returns (
        bytes32 nodeId_,
        bytes32 taskId_,
        address claimedBy_,
        bytes32 outputHash_,
        bool validated_
    );
    function resetNode(bytes32 nodeId) external;
}

/**
 * @title SlashingVault
 * @dev Decentralized challenge resolution. Replaces the previous onlyOwner
 *      admin path with an LLM-Judge jury: any RUNNING agent in AgentRegistry
 *      (other than the accused or the original challenger) may cast a verdict.
 *      The first QUORUM votes lock the outcome and trigger the slash with no
 *      further intervention. If the voting window expires before quorum,
 *      anyone can call finalizeExpired() to settle by simple majority of
 *      whatever votes were cast — zero votes drops the challenge cleanly
 *      (presumed innocent, no slash on either side).
 *
 *      Economic outcomes are unchanged from the admin-resolved version:
 *        accused guilty   → 80% of accused subtask stake burned,
 *                           20% paid to original challenger as bounty.
 *        accused innocent → 20% of challenger's stake burned (false-positive
 *                           penalty). Subtask-level if challenger is a worker,
 *                           task-level if challenger is the planner.
 */
contract SlashingVault {
    struct Challenge {
        bytes32 nodeId;
        // The challenger's own subtask. 0x0 means the challenger is the
        // planner (whose stake lives at task-level, not subtask-level).
        bytes32 challengerNodeId;
        address challenger;
        address accused;
        uint64  deadline;
        uint8   guiltyVotes;
        uint8   innocentVotes;
        bool    resolved;
    }

    uint256 public constant VOTING_WINDOW            = 1 hours;
    uint8   public constant QUORUM                   = 3;
    uint8   public constant STATUS_RUNNING           = 1;

    uint256 public constant ACCUSED_BURN_BPS         = 8000;
    uint256 public constant CHALLENGER_REWARD_BPS    = 2000;
    uint256 public constant FALSE_CHALLENGER_BURN_BPS = 2000;

    ISwarmEscrow  public immutable escrow;
    IDAGRegistry  public immutable registry;
    AgentRegistry public immutable agents;

    mapping(bytes32 => Challenge) public challenges;
    // nodeId => juror EOA => 0 = none, 1 = guilty, 2 = innocent.
    // Keying ballots by EOA (not agentId) prevents the same wallet from
    // casting two votes through two different registered agentIds.
    mapping(bytes32 => mapping(address => uint8)) public ballots;
    mapping(bytes32 => address[]) private _jurors;

    event ChallengeRaised(bytes32 indexed nodeId, address indexed challenger, address indexed accused, uint64 deadline);
    event JurorVoted(bytes32 indexed nodeId, address indexed juror, bool guilty);
    event ChallengeResolved(bytes32 indexed nodeId, bool accusedGuilty, uint8 guiltyVotes, uint8 innocentVotes);
    event SlashExecuted(bytes32 indexed nodeId, address indexed accused);
    event FalseChallenge(bytes32 indexed nodeId, address indexed challenger);

    constructor(address _escrow, address _registry, address _agents) {
        require(_escrow != address(0) && _registry != address(0) && _agents != address(0), "zero addr");
        escrow = ISwarmEscrow(_escrow);
        registry = IDAGRegistry(_registry);
        agents = AgentRegistry(_agents);
    }

    function challenge(
        bytes32 nodeId,
        address accused,
        bytes32 challengerNodeId
    ) external {
        require(challenges[nodeId].deadline == 0, "Challenge exists");
        require(accused != address(0), "Invalid accused");
        require(accused != msg.sender, "Cannot self-challenge");

        uint64 deadline = uint64(block.timestamp + VOTING_WINDOW);
        challenges[nodeId] = Challenge({
            nodeId: nodeId,
            challengerNodeId: challengerNodeId,
            challenger: msg.sender,
            accused: accused,
            deadline: deadline,
            guiltyVotes: 0,
            innocentVotes: 0,
            resolved: false
        });

        emit ChallengeRaised(nodeId, msg.sender, accused, deadline);
    }

    /// LLM-Judge jury vote. Caller proves they are an active registered agent
    /// by passing their own agentId from AgentRegistry; the contract checks
    /// agentAddress == msg.sender and status == RUNNING. Accused and the
    /// original challenger are excluded. The first QUORUM votes auto-resolve.
    function vote(bytes32 nodeId, bytes32 jurorAgentId, bool accusedGuilty) external {
        Challenge storage ch = challenges[nodeId];
        require(ch.deadline != 0, "No challenge");
        require(!ch.resolved, "Already resolved");
        require(block.timestamp <= ch.deadline, "Voting closed");
        require(msg.sender != ch.accused && msg.sender != ch.challenger, "Conflicted juror");
        require(ballots[nodeId][msg.sender] == 0, "Already voted");

        AgentRegistry.Agent memory a = agents.getAgent(jurorAgentId);
        require(a.agentAddress == msg.sender, "Not your agent id");
        require(a.status == STATUS_RUNNING, "Inactive agent");

        ballots[nodeId][msg.sender] = accusedGuilty ? 1 : 2;
        _jurors[nodeId].push(msg.sender);
        if (accusedGuilty) {
            ch.guiltyVotes++;
        } else {
            ch.innocentVotes++;
        }

        emit JurorVoted(nodeId, msg.sender, accusedGuilty);

        if (ch.guiltyVotes + ch.innocentVotes >= QUORUM) {
            _resolve(nodeId, ch.guiltyVotes > ch.innocentVotes);
        }
    }

    /// After the voting window closes, anyone can sweep. Majority of whatever
    /// votes exist wins; ties default to innocent (presumed innocent rule).
    /// Zero votes drops the challenge without slashing either party.
    function finalizeExpired(bytes32 nodeId) external {
        Challenge storage ch = challenges[nodeId];
        require(ch.deadline != 0, "No challenge");
        require(!ch.resolved, "Already resolved");
        require(block.timestamp > ch.deadline, "Still voting");

        uint8 g = ch.guiltyVotes;
        uint8 i = ch.innocentVotes;
        if (g == 0 && i == 0) {
            ch.resolved = true;
            emit ChallengeResolved(nodeId, false, 0, 0);
            return;
        }
        _resolve(nodeId, g > i);
    }

    function _resolve(bytes32 nodeId, bool accusedGuilty) internal {
        Challenge storage ch = challenges[nodeId];
        (, bytes32 taskId, , , ) = registry.nodes(nodeId);

        if (accusedGuilty) {
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
        emit ChallengeResolved(nodeId, accusedGuilty, ch.guiltyVotes, ch.innocentVotes);
    }

    function getChallenge(bytes32 nodeId) external view returns (Challenge memory) {
        return challenges[nodeId];
    }

    function getJurors(bytes32 nodeId) external view returns (address[] memory) {
        return _jurors[nodeId];
    }
}
