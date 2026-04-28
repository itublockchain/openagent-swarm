// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

interface ISwarmEscrow {
    function settle(bytes32 taskId, address[] calldata winners) external;
    function settleWithAmounts(
        bytes32 taskId,
        address[] calldata winners,
        uint256[] calldata amounts
    ) external;
    function releaseSubtaskStake(bytes32 taskId, bytes32 nodeId) external;
}

/**
 * @title DAGRegistry
 * @dev Manages planner selection, DAG registration, and subtask claims.
 */
contract DAGRegistry is Ownable {
    struct DAGNode {
        bytes32 nodeId;
        bytes32 taskId;
        address claimedBy;
        bytes32 outputHash;
        bool validated;
    }

    ISwarmEscrow public escrow;
    address public vault;

    mapping(bytes32 => address) public planners;
    mapping(bytes32 => DAGNode) public nodes;
    mapping(bytes32 => bytes32[]) public taskNodes;

    event PlannerSelected(bytes32 indexed taskId, address indexed planner);
    event SubtaskClaimed(bytes32 indexed nodeId, address indexed agent);
    event OutputSubmitted(bytes32 indexed nodeId, address indexed agent, bytes32 outputHash);
    event DAGCompleted(bytes32 indexed taskId);
    event NodeReset(bytes32 indexed nodeId);

    constructor() Ownable(msg.sender) {}

    function setAddresses(address _escrow, address _vault) external onlyOwner {
        escrow = ISwarmEscrow(_escrow);
        vault = _vault;
    }

    function claimPlanner(bytes32 taskId) external returns (bool) {
        if (planners[taskId] != address(0)) {
            return false;
        }
        planners[taskId] = msg.sender;
        emit PlannerSelected(taskId, msg.sender);
        return true;
    }

    function registerDAG(bytes32 taskId, bytes32[] calldata nodeIds) external {
        require(planners[taskId] == msg.sender, "Only assigned planner");
        require(taskNodes[taskId].length == 0, "Already registered");
        require(nodeIds.length > 0, "Empty DAG");

        for (uint256 i = 0; i < nodeIds.length; i++) {
            bytes32 nid = nodeIds[i];
            nodes[nid] = DAGNode({
                nodeId: nid,
                taskId: taskId,
                claimedBy: address(0),
                outputHash: bytes32(0),
                validated: false
            });
        }
        taskNodes[taskId] = nodeIds;
    }

    function claimSubtask(bytes32 nodeId) external returns (bool) {
        if (nodes[nodeId].taskId == bytes32(0) || nodes[nodeId].claimedBy != address(0)) {
            return false;
        }
        nodes[nodeId].claimedBy = msg.sender;
        emit SubtaskClaimed(nodeId, msg.sender);
        return true;
    }

    function submitOutput(bytes32 nodeId, bytes32 outputHash) external {
        require(nodes[nodeId].claimedBy == msg.sender, "Only claimant");
        nodes[nodeId].outputHash = outputHash;
        emit OutputSubmitted(nodeId, msg.sender, outputHash);
    }

    function markValidated(bytes32 nodeId) external {
        bytes32 tid = nodes[nodeId].taskId;
        require(tid != bytes32(0), "Node not found");
        require(msg.sender == vault || msg.sender == planners[tid], "Unauthorized");

        nodes[nodeId].validated = true;
        // Worker's subtask stake is now safe to return.
        escrow.releaseSubtaskStake(tid, nodeId);

        bytes32[] memory nodeIds = taskNodes[tid];
        bool allValidated = true;
        address[] memory winners = new address[](nodeIds.length);

        for (uint256 i = 0; i < nodeIds.length; i++) {
            if (!nodes[nodeIds[i]].validated) {
                allValidated = false;
                break;
            }
            winners[i] = nodes[nodeIds[i]].claimedBy;
        }

        if (allValidated && nodeIds.length > 0) {
            emit DAGCompleted(tid);
            escrow.settle(tid, winners);
        }
    }

    /// Validates many nodes in one tx WITHOUT triggering automatic settlement.
    /// Caller (typically the planner) is expected to follow up with an explicit
    /// SwarmEscrow.settleWithAmounts call to control payout amounts.
    function markValidatedBatch(bytes32[] calldata nodeIds) external {
        require(nodeIds.length > 0, "Empty list");
        bytes32 tid = nodes[nodeIds[0]].taskId;
        require(tid != bytes32(0), "Node not found");
        require(msg.sender == vault || msg.sender == planners[tid], "Unauthorized");

        for (uint256 i = 0; i < nodeIds.length; i++) {
            bytes32 nid = nodeIds[i];
            require(nodes[nid].taskId == tid, "Mixed tasks");
            nodes[nid].validated = true;
            escrow.releaseSubtaskStake(tid, nid);
        }
        emit DAGCompleted(tid);
    }

    function getTaskNodes(bytes32 taskId) external view returns (bytes32[] memory) {
        return taskNodes[taskId];
    }

    /// Planner-gated explicit settlement. Forwards to SwarmEscrow.settleWithAmounts
    /// after verifying the caller is the registered planner for this task.
    function requestSettle(
        bytes32 taskId,
        address[] calldata winners,
        uint256[] calldata amounts
    ) external {
        require(planners[taskId] == msg.sender, "Only planner");
        require(winners.length == amounts.length, "Length mismatch");
        escrow.settleWithAmounts(taskId, winners, amounts);
    }

    function resetNode(bytes32 nodeId) external {
        require(msg.sender == vault, "Only vault can reset");
        nodes[nodeId].claimedBy = address(0);
        nodes[nodeId].outputHash = bytes32(0);
        nodes[nodeId].validated = false;
        emit NodeReset(nodeId);
    }
}
