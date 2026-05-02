// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * @title SporeCoordinator
 * @notice Lightweight on-chain registry + state machine + Byzantine
 *         validator-vote verifier for the SPORE SDK multi-agent
 *         orchestrator.
 *
 *         Agents are role-agnostic at registration. Roles emerge per
 *         task: one FCFS planner, the others workers, and EVERY agent
 *         in the swarm (except the current node's executor) is an
 *         eligible validator. The contract verifies each validator
 *         signature and tallies a strict-majority verdict.
 *
 *         No funds touch this contract — gas is paid by the SDK
 *         service operator and billed to the dev's API key Treasury
 *         balance off-chain. No budget, no rewards, no slashing.
 *
 *         State machine (per task):
 *           PENDING → DAG_READY → EXECUTING ⇄ VALIDATING → COMPLETED
 */
contract SporeCoordinator {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    // ─── Types ──────────────────────────────────────────────────────────

    enum TaskState { PENDING, DAG_READY, EXECUTING, VALIDATING, COMPLETED }

    struct Agent {
        address wallet;        // signature recovery target for validators
        uint256 reputation;    // +1 per task the agent contributed to
        bool isActive;
    }

    struct Task {
        address operator;              // who can advance the state machine
        bytes32 specHash;
        bytes32 plannerAgent;          // FCFS-elected planner (set at submitTask)
        bytes32[] participatingAgents; // every agent in this swarm — eligible voter pool
        bytes32[] executorAgents;      // executorAgents[i] = LATEST executor for node i (after retries)
        bytes32 dagHash;
        bytes32[] outputHashes;
        uint8[] nodeAttempts;
        uint8[] nodeValidVotes;
        TaskState state;
        uint256 createdAt;
    }

    struct ValidatorVote {
        bytes32 agentId;
        bool valid;
        bytes signature;       // 65-byte ECDSA
    }

    // ─── Storage ────────────────────────────────────────────────────────

    mapping(bytes32 => Agent) private _agents;
    bytes32[] public allAgentIds;

    mapping(bytes32 => Task) private _tasks;
    bytes32[] public allTaskIds;

    /// Per-task per-node per-validator dedup. Without this, the operator
    /// could double-count a validator's verdict by submitting the same
    /// signature twice across separate submitValidations calls.
    mapping(bytes32 => mapping(uint256 => mapping(bytes32 => bool))) public hasVoted;

    // ─── Events ─────────────────────────────────────────────────────────

    event AgentRegistered(bytes32 indexed agentId, address wallet);
    event AgentDeregistered(bytes32 indexed agentId);

    event TaskSubmitted(
        bytes32 indexed taskId,
        address indexed operator,
        bytes32 plannerAgent
    );
    event DAGRegistered(bytes32 indexed taskId, bytes32 dagHash, uint256 nodeCount);
    event NodeOutputSubmitted(
        bytes32 indexed taskId,
        uint256 indexed nodeIndex,
        bytes32 indexed executorAgent,
        bytes32 outputHash,
        uint8 attempt
    );
    event ValidatorVoteRecorded(
        bytes32 indexed taskId,
        uint256 indexed nodeIndex,
        bytes32 indexed validatorAgent,
        bool valid
    );
    event NodeAccepted(bytes32 indexed taskId, uint256 indexed nodeIndex, uint8 validVotes, uint8 totalEligible);
    event NodeRejected(bytes32 indexed taskId, uint256 indexed nodeIndex, uint8 validVotes, uint8 totalEligible);
    event TaskStateChanged(bytes32 indexed taskId, TaskState newState);
    event TaskCompleted(bytes32 indexed taskId);

    // ─── Modifiers ──────────────────────────────────────────────────────

    modifier onlyOperator(bytes32 taskId) {
        require(_tasks[taskId].operator == msg.sender, "not operator");
        _;
    }

    modifier taskExists(bytes32 taskId) {
        require(_tasks[taskId].operator != address(0), "unknown task");
        _;
    }

    // ─── Agent registry ────────────────────────────────────────────────

    /**
     * @notice Bind an agent identifier to a wallet. First call creates
     *         the row; subsequent calls with the same id + wallet are
     *         no-ops (idempotent). Agents are role-agnostic — every
     *         registered agent can be planner, worker, or validator
     *         depending on which task it ends up in.
     */
    function registerAgent(bytes32 agentId, address wallet) external {
        require(agentId != bytes32(0), "id=0");
        require(wallet != address(0), "wallet=0");
        Agent storage a = _agents[agentId];
        if (a.wallet == address(0)) {
            a.wallet = wallet;
            a.isActive = true;
            allAgentIds.push(agentId);
            emit AgentRegistered(agentId, wallet);
        } else {
            require(a.wallet == wallet, "wallet mismatch");
            require(a.isActive, "deregistered");
            // already registered — no-op idempotent path
        }
    }

    function deregisterAgent(bytes32 agentId) external {
        Agent storage a = _agents[agentId];
        require(a.isActive, "unknown");
        require(msg.sender == a.wallet, "auth");
        a.isActive = false;
        emit AgentDeregistered(agentId);
    }

    function getAgent(bytes32 agentId) external view returns (Agent memory) {
        return _agents[agentId];
    }

    function totalAgents() external view returns (uint256) {
        return allAgentIds.length;
    }

    // ─── Task lifecycle ────────────────────────────────────────────────

    /**
     * @notice Open a new task. Caller is locked in as the operator and
     *         is the only address that can advance state. The full
     *         participating-agent set is recorded here — eligible voter
     *         pool per node = participatingAgents minus that node's
     *         executor.
     */
    function submitTask(
        bytes32 taskId,
        bytes32 specHash,
        bytes32 plannerAgent,
        bytes32[] calldata participatingAgents
    ) external {
        require(taskId != bytes32(0), "taskId=0");
        require(_tasks[taskId].operator == address(0), "exists");
        require(_agents[plannerAgent].isActive, "planner inactive");
        require(participatingAgents.length >= 2, "need >=2 agents (planner + 1 worker/validator)");
        // Planner must be in the participating set so the validator-pool
        // logic can correctly exclude the current executor (== planner
        // when the planner also works a node).
        bool plannerInSet = false;
        for (uint256 i = 0; i < participatingAgents.length; i++) {
            require(_agents[participatingAgents[i]].isActive, "agent inactive");
            if (participatingAgents[i] == plannerAgent) plannerInSet = true;
        }
        require(plannerInSet, "planner not in participants");

        Task storage t = _tasks[taskId];
        t.operator = msg.sender;
        t.specHash = specHash;
        t.plannerAgent = plannerAgent;
        t.participatingAgents = participatingAgents;
        t.state = TaskState.PENDING;
        t.createdAt = block.timestamp;
        allTaskIds.push(taskId);

        emit TaskSubmitted(taskId, msg.sender, plannerAgent);
        emit TaskStateChanged(taskId, TaskState.PENDING);
    }

    function registerDAG(
        bytes32 taskId,
        bytes32 dagHash,
        uint256 nodeCount
    ) external taskExists(taskId) onlyOperator(taskId) {
        Task storage t = _tasks[taskId];
        require(t.state == TaskState.PENDING, "bad state");
        require(nodeCount > 0, "empty dag");
        t.dagHash = dagHash;
        t.executorAgents = new bytes32[](nodeCount);
        t.outputHashes = new bytes32[](nodeCount);
        t.nodeAttempts = new uint8[](nodeCount);
        t.nodeValidVotes = new uint8[](nodeCount);
        t.state = TaskState.DAG_READY;
        emit DAGRegistered(taskId, dagHash, nodeCount);
        emit TaskStateChanged(taskId, TaskState.DAG_READY);
    }

    /**
     * @notice Submit the worker's output for one node. Re-callable for
     *         the same nodeIndex on retry; `attempt` increments. Resets
     *         per-node validator dedup so the new output gets a fresh
     *         vote round.
     */
    function submitNodeOutput(
        bytes32 taskId,
        uint256 nodeIndex,
        bytes32 executorAgent,
        bytes32 outputHash
    ) external taskExists(taskId) onlyOperator(taskId) {
        Task storage t = _tasks[taskId];
        require(
            t.state == TaskState.DAG_READY ||
                t.state == TaskState.EXECUTING ||
                t.state == TaskState.VALIDATING,
            "bad state"
        );
        require(nodeIndex < t.outputHashes.length, "bad index");
        require(_agents[executorAgent].isActive, "executor inactive");
        require(_isParticipant(t.participatingAgents, executorAgent), "executor not participant");

        // On retry, clear previous votes for this node.
        if (t.outputHashes[nodeIndex] != bytes32(0)) {
            for (uint256 i = 0; i < t.participatingAgents.length; i++) {
                hasVoted[taskId][nodeIndex][t.participatingAgents[i]] = false;
            }
            t.nodeValidVotes[nodeIndex] = 0;
        }

        t.executorAgents[nodeIndex] = executorAgent;
        t.outputHashes[nodeIndex] = outputHash;
        t.nodeAttempts[nodeIndex] += 1;

        if (t.state == TaskState.DAG_READY) {
            t.state = TaskState.EXECUTING;
            emit TaskStateChanged(taskId, TaskState.EXECUTING);
        }
        emit NodeOutputSubmitted(
            taskId,
            nodeIndex,
            executorAgent,
            outputHash,
            t.nodeAttempts[nodeIndex]
        );
    }

    /**
     * @notice Submit a batch of validator votes for a single node.
     *         Eligible voter set = participatingAgents \ {current executor}.
     *         The contract recovers each signature against the registered
     *         agent's wallet and counts only verified votes. Bad sigs
     *         are silently skipped.
     *
     *         Tally rule: validVotes * 2 > eligibleVoterCount (strict
     *         majority over the full eligible pool, NOT just submitted
     *         votes — partial submissions can't accidentally cross
     *         quorum by reducing the denominator).
     *
     *         Vote signature payload (must match the SDK):
     *           keccak256(abi.encode(taskId, nodeIndex, outputHash, valid, agentId))
     *           wrapped with EIP-191 toEthSignedMessageHash.
     */
    function submitValidations(
        bytes32 taskId,
        uint256 nodeIndex,
        ValidatorVote[] calldata votes
    ) external taskExists(taskId) onlyOperator(taskId) {
        Task storage t = _tasks[taskId];
        require(
            t.state == TaskState.EXECUTING || t.state == TaskState.VALIDATING,
            "bad state"
        );
        require(nodeIndex < t.outputHashes.length, "bad index");
        bytes32 outHash = t.outputHashes[nodeIndex];
        require(outHash != bytes32(0), "no output");
        bytes32 currentExecutor = t.executorAgents[nodeIndex];

        for (uint256 i = 0; i < votes.length; i++) {
            ValidatorVote calldata v = votes[i];
            // Eligibility: participant, not the current executor, not
            // already voted, signature valid.
            if (hasVoted[taskId][nodeIndex][v.agentId]) continue;
            if (!_isParticipant(t.participatingAgents, v.agentId)) continue;
            if (v.agentId == currentExecutor) continue;
            Agent storage a = _agents[v.agentId];
            if (!a.isActive) continue;

            bytes32 raw = keccak256(
                abi.encode(taskId, nodeIndex, outHash, v.valid, v.agentId)
            );
            address recovered = raw.toEthSignedMessageHash().recover(v.signature);
            if (recovered != a.wallet) continue;

            hasVoted[taskId][nodeIndex][v.agentId] = true;
            if (v.valid) t.nodeValidVotes[nodeIndex] += 1;
            emit ValidatorVoteRecorded(taskId, nodeIndex, v.agentId, v.valid);
        }

        // Tally over eligible voters = participants - {current executor}.
        uint8 eligible = uint8(t.participatingAgents.length - 1);
        uint8 validCount = t.nodeValidVotes[nodeIndex];
        if (validCount * 2 > eligible) {
            emit NodeAccepted(taskId, nodeIndex, validCount, eligible);
            if (t.state != TaskState.VALIDATING) {
                t.state = TaskState.VALIDATING;
                emit TaskStateChanged(taskId, TaskState.VALIDATING);
            }
        } else {
            uint8 votesIn = _countVotesIn(taskId, nodeIndex, t.participatingAgents, currentExecutor);
            uint8 outstanding = eligible - votesIn;
            if ((validCount + outstanding) * 2 <= eligible) {
                emit NodeRejected(taskId, nodeIndex, validCount, eligible);
            }
        }
    }

    function completeTask(bytes32 taskId)
        external
        taskExists(taskId)
        onlyOperator(taskId)
    {
        Task storage t = _tasks[taskId];
        require(t.state == TaskState.VALIDATING, "bad state");
        uint8 eligible = uint8(t.participatingAgents.length - 1);
        for (uint256 i = 0; i < t.outputHashes.length; i++) {
            require(t.nodeValidVotes[i] * 2 > eligible, "node not accepted");
        }

        // Reputation +1 for every contributing agent. Planner gets a
        // bump too (it ran plan + may have voted on every node).
        _bumpReputation(t.plannerAgent, 1);
        for (uint256 i = 0; i < t.executorAgents.length; i++) {
            bytes32 eid = t.executorAgents[i];
            if (eid != bytes32(0)) _bumpReputation(eid, 1);
        }

        t.state = TaskState.COMPLETED;
        emit TaskStateChanged(taskId, TaskState.COMPLETED);
        emit TaskCompleted(taskId);
    }

    // ─── Reads ─────────────────────────────────────────────────────────

    function getTask(bytes32 taskId) external view returns (Task memory) {
        return _tasks[taskId];
    }

    function getNodeStatus(bytes32 taskId, uint256 nodeIndex)
        external
        view
        returns (
            bytes32 executor,
            bytes32 outputHash,
            uint8 attempts,
            uint8 validVotes,
            uint8 totalEligible
        )
    {
        Task storage t = _tasks[taskId];
        require(nodeIndex < t.outputHashes.length, "bad index");
        executor = t.executorAgents[nodeIndex];
        outputHash = t.outputHashes[nodeIndex];
        attempts = t.nodeAttempts[nodeIndex];
        validVotes = t.nodeValidVotes[nodeIndex];
        totalEligible = uint8(t.participatingAgents.length - 1);
    }

    function totalTasks() external view returns (uint256) {
        return allTaskIds.length;
    }

    // ─── Internals ─────────────────────────────────────────────────────

    function _isParticipant(bytes32[] storage set, bytes32 id) internal view returns (bool) {
        for (uint256 i = 0; i < set.length; i++) {
            if (set[i] == id) return true;
        }
        return false;
    }

    function _countVotesIn(
        bytes32 taskId,
        uint256 nodeIndex,
        bytes32[] storage participants,
        bytes32 excludeAgent
    ) internal view returns (uint8 n) {
        for (uint256 i = 0; i < participants.length; i++) {
            if (participants[i] == excludeAgent) continue;
            if (hasVoted[taskId][nodeIndex][participants[i]]) n += 1;
        }
    }

    function _bumpReputation(bytes32 agentId, uint256 delta) internal {
        _agents[agentId].reputation += delta;
    }
}
