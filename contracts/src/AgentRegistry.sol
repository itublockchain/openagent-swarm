// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title AgentRegistry
 * @dev Public, verifiable registry of agents in the swarm. Any API node /
 *      explorer / user can read the live pool from chain. Private keys are
 *      kept off-chain (encrypted on the API host); only the agent's public
 *      EOA address is stored here.
 *
 *      Status state machine:
 *          PENDING (0) → RUNNING (1) → STOPPED (2)
 *          PENDING (0) → ERROR   (3)
 *          RUNNING (1) → STOPPED (2) | ERROR (3)
 *          STOPPED (2) → RUNNING (1)              // respawn after restart
 *          ERROR   (3) → terminal (re-register only)
 *
 *      Authorization: only the original `owner` (deployer) OR the agent's own
 *      `agentAddress` may transition status. The owner can also re-register
 *      the same agentId after an ERROR to recover.
 */
contract AgentRegistry {
    uint8 public constant STATUS_PENDING = 0;
    uint8 public constant STATUS_RUNNING = 1;
    uint8 public constant STATUS_STOPPED = 2;
    uint8 public constant STATUS_ERROR   = 3;

    struct Agent {
        address owner;
        address agentAddress;
        string  name;
        string  model;
        uint256 stakeAmount;
        uint8   status;
        uint64  deployedAt;
        bool    exists;
    }

    mapping(bytes32 => Agent) private _agents;
    bytes32[] public allIds;

    event AgentRegistered(
        bytes32 indexed id,
        address indexed owner,
        address indexed agentAddress,
        string name,
        string model,
        uint256 stakeAmount
    );
    event AgentStatusChanged(bytes32 indexed id, uint8 status);

    function register(
        bytes32 id,
        address agentAddress,
        string calldata name,
        string calldata model,
        uint256 stakeAmount
    ) external {
        require(id != bytes32(0), "id=0");
        require(agentAddress != address(0), "agentAddress=0");

        Agent storage a = _agents[id];
        if (!a.exists) {
            allIds.push(id);
        } else {
            // Re-registration only allowed by the original owner after ERROR.
            require(msg.sender == a.owner, "not owner");
            require(a.status == STATUS_ERROR, "already active");
        }

        a.owner = msg.sender;
        a.agentAddress = agentAddress;
        a.name = name;
        a.model = model;
        a.stakeAmount = stakeAmount;
        a.status = STATUS_PENDING;
        a.deployedAt = uint64(block.timestamp);
        a.exists = true;

        emit AgentRegistered(id, msg.sender, agentAddress, name, model, stakeAmount);
    }

    function setStatus(bytes32 id, uint8 newStatus) external {
        Agent storage a = _agents[id];
        require(a.exists, "unknown id");
        require(msg.sender == a.owner || msg.sender == a.agentAddress, "unauthorized");
        require(newStatus <= STATUS_ERROR, "bad status");

        uint8 cur = a.status;
        require(cur != STATUS_ERROR, "terminal");
        if (cur == newStatus) return;

        // Allowed transitions, encoded explicitly to make the state machine
        // visible on-chain rather than relying on caller discipline.
        bool ok =
            (cur == STATUS_PENDING && (newStatus == STATUS_RUNNING || newStatus == STATUS_ERROR)) ||
            (cur == STATUS_RUNNING && (newStatus == STATUS_STOPPED || newStatus == STATUS_ERROR)) ||
            (cur == STATUS_STOPPED && (newStatus == STATUS_RUNNING || newStatus == STATUS_ERROR));
        require(ok, "bad transition");

        a.status = newStatus;
        emit AgentStatusChanged(id, newStatus);
    }

    function getAgent(bytes32 id) external view returns (Agent memory) {
        Agent memory a = _agents[id];
        require(a.exists, "unknown id");
        return a;
    }

    function exists(bytes32 id) external view returns (bool) {
        return _agents[id].exists;
    }

    function totalAgents() external view returns (uint256) {
        return allIds.length;
    }

    /// Paginated enumeration. `limit=0` returns up to MAX_PAGE entries.
    function listAgents(uint256 offset, uint256 limit)
        external
        view
        returns (bytes32[] memory ids, Agent[] memory rows)
    {
        uint256 total = allIds.length;
        if (offset >= total) {
            return (new bytes32[](0), new Agent[](0));
        }
        uint256 end = limit == 0 ? total : offset + limit;
        if (end > total) end = total;
        uint256 n = end - offset;

        ids = new bytes32[](n);
        rows = new Agent[](n);
        for (uint256 i = 0; i < n; i++) {
            bytes32 id = allIds[offset + i];
            ids[i] = id;
            rows[i] = _agents[id];
        }
    }
}
