// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

interface ISwarmEscrow {
    function settle(bytes32 taskId, address[] calldata winners) external;
}

/**
 * @title DAGRegistry
 * @dev Manages planner selection, DAG registration, and subtask claims with FCFS logic.
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

    mapping(bytes32 => address) public planners;        // taskId -> planner
    mapping(bytes32 => DAGNode) public nodes;           // nodeId -> node
    mapping(bytes32 => bytes32[]) public taskNodes;     // taskId -> nodeId[]

    event PlannerSelected(bytes32 indexed taskId, address indexed planner);
    event SubtaskClaimed(bytes32 indexed nodeId, address indexed agent);
    event OutputSubmitted(bytes32 indexed nodeId, address indexed agent, bytes32 outputHash);
    event DAGCompleted(bytes32 indexed taskId);

    constructor() Ownable(msg.sender) {}

    /**
     * @dev Sets the escrow and vault addresses.
     */
    function setAddresses(address _escrow, address _vault) external onlyOwner {
        escrow = ISwarmEscrow(_escrow);
        vault = _vault;
    }

    /**
     * @notice Claims the planner role for a task. First come, first served.
     * @param taskId Unique identifier for the task.
     * @return true if successful, false if already claimed.
     */
    function claimPlanner(bytes32 taskId) external returns (bool) {
        if (planners[taskId] != address(0)) {
            return false;
        }
        planners[taskId] = msg.sender;
        emit PlannerSelected(taskId, msg.sender);
        return true;
    }

    /**
     * @notice Registers the DAG structure for a task.
     * @param taskId Identifier of the task.
     * @param nodeIds Array of unique node identifiers representing the DAG.
     */
    function registerDAG(bytes32 taskId, bytes32[] calldata nodeIds) external {
        require(planners[taskId] == msg.sender, "Only assigned planner can register DAG");
        require(taskNodes[taskId].length == 0, "DAG already registered");

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

    /**
     * @notice Claims a specific subtask node. First come, first served.
     * @param nodeId Identifier of the node to claim.
     * @return true if successful, false if already claimed.
     */
    function claimSubtask(bytes32 nodeId) external returns (bool) {
        if (nodes[nodeId].claimedBy != address(0) || nodes[nodeId].taskId == bytes32(0)) {
            return false;
        }
        nodes[nodeId].claimedBy = msg.sender;
        emit SubtaskClaimed(nodeId, msg.sender);
        return true;
    }

    /**
     * @notice Submits the computed output for a subtask.
     * @param nodeId Identifier of the node.
     * @param outputHash Hash of the computation results.
     */
    function submitOutput(bytes32 nodeId, bytes32 outputHash) external {
        require(nodes[nodeId].claimedBy == msg.sender, "Only claimant can submit output");
        nodes[nodeId].outputHash = outputHash;
        emit OutputSubmitted(nodeId, msg.sender, outputHash);
    }

    /**
     * @notice Marks a node as validated. Triggers settlement if DAG is complete.
     * @param nodeId Identifier of the node to validate.
     */
    function markValidated(bytes32 nodeId) external {
        bytes32 tid = nodes[nodeId].taskId;
        require(msg.sender == vault || msg.sender == planners[tid], "Unauthorized validator");
        
        nodes[nodeId].validated = true;

        // Check if all nodes in the task are validated
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

        if (allValidated) {
            emit DAGCompleted(tid);
            escrow.settle(tid, winners);
        }
    }
}
