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
    /// Read the canonical Task struct so forceComplete can derive the
    /// per-worker share on-chain instead of trusting a caller-supplied
    /// amounts[] array. Order matches the Task struct field declaration:
    /// (owner, budget, stakedTotal, finalized).
    function tasks(bytes32 taskId)
        external
        view
        returns (address owner, uint256 budget, uint256 stakedTotal, bool finalized);
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
    /// Wall-clock timestamp of the most recent claimSubtask. Used by
    /// expireClaim() to free orphaned slots whose worker never submitted.
    /// Without this, a free claimSubtask call from an off-chain attacker
    /// (no stake required by the contract) could lock a node forever:
    /// the slash path requires a non-zero subtask stake to succeed.
    mapping(bytes32 => uint64) public claimedAt;

    /// How long an unsubmitted claim can hold a slot before anyone can
    /// expire it. 10 minutes is comfortably longer than any honest
    /// inference + storage round trip on 0G testnet.
    uint64 public constant CLAIM_TTL = 10 minutes;

    /// Wall-clock timestamp of the most recent registerDAG / submitOutput
    /// for the task. Drives the keeper-timeout: if the planner-keeper
    /// hasn't called requestSettle within KEEPER_TIMEOUT of the last
    /// activity, anyone can call forceComplete to settle the DAG.
    /// Without this, an offline / restarted planner locks the task budget
    /// (and every worker's task-level stake) forever — the original
    /// design has no permissionless escape from "all nodes submitted but
    /// planner won't settle".
    mapping(bytes32 => uint64) public lastActivityAt;

    /// Demo timing — keepers normally settle within seconds of the last
    /// SUBTASK_DONE. 90s gives an honest planner-keeper plenty of slack
    /// (judge round + tx confirm) before peers step in. Production
    /// deployments should restore minute-scale (e.g. 5–10 min) so brief
    /// operator outages don't trigger forceComplete races.
    uint64 public constant KEEPER_TIMEOUT = 90 seconds;

    event PlannerSelected(bytes32 indexed taskId, address indexed planner);
    event SubtaskClaimed(bytes32 indexed nodeId, address indexed agent);
    event OutputSubmitted(bytes32 indexed nodeId, address indexed agent, bytes32 outputHash);
    event DAGCompleted(bytes32 indexed taskId);
    event NodeReset(bytes32 indexed nodeId);
    event ClaimExpired(bytes32 indexed nodeId, address indexed previousClaimant);
    /// Emitted when forceComplete fires — distinct from DAGCompleted so
    /// off-chain indexers can tell "planner did their job" apart from
    /// "peers stepped in because the planner was unresponsive".
    event DAGForceCompleted(bytes32 indexed taskId, address indexed forcer, address indexed planner);

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
        // Seed the keeper-timeout clock — workers have KEEPER_TIMEOUT to
        // start submitting outputs, then each submitOutput resets it.
        lastActivityAt[taskId] = uint64(block.timestamp);
    }

    function claimSubtask(bytes32 nodeId) external returns (bool) {
        if (nodes[nodeId].taskId == bytes32(0) || nodes[nodeId].claimedBy != address(0)) {
            return false;
        }
        nodes[nodeId].claimedBy = msg.sender;
        claimedAt[nodeId] = uint64(block.timestamp);
        emit SubtaskClaimed(nodeId, msg.sender);
        return true;
    }

    function submitOutput(bytes32 nodeId, bytes32 outputHash) external {
        require(nodes[nodeId].claimedBy == msg.sender, "Only claimant");
        nodes[nodeId].outputHash = outputHash;
        // Reset the keeper-timeout clock — every submitOutput is a sign
        // of life from the swarm; only after KEEPER_TIMEOUT of true
        // silence can forceComplete fire.
        lastActivityAt[nodes[nodeId].taskId] = uint64(block.timestamp);
        emit OutputSubmitted(nodeId, msg.sender, outputHash);
    }

    /// Anyone may call after CLAIM_TTL elapses if the worker still hasn't
    /// submitted output. Frees the slot by zeroing claimedBy so the next
    /// claimSubtask succeeds. We deliberately allow permissionless callers
    /// — the worst they can do is unlock a slot that was already overdue.
    /// This is the escape hatch for the "free claim → permanent lock" DoS:
    /// SlashingVault can't slash a stake-less claim (slashSubtaskPartial
    /// reverts on stake==0), so the only way out is time-based release.
    function expireClaim(bytes32 nodeId) external {
        DAGNode storage n = nodes[nodeId];
        require(n.taskId != bytes32(0), "Node not found");
        require(n.claimedBy != address(0), "Not claimed");
        require(n.outputHash == bytes32(0), "Output already submitted");
        require(block.timestamp >= claimedAt[nodeId] + CLAIM_TTL, "Claim still active");
        require(!n.validated, "Already validated");

        address prev = n.claimedBy;
        n.claimedBy = address(0);
        claimedAt[nodeId] = 0;
        emit ClaimExpired(nodeId, prev);
    }

    /// Mark a single node validated. Releases that worker's subtask stake.
    /// Does NOT auto-settle the task — settlement is an explicit, planner-gated
    /// operation via requestSettle, which enforces the weighted split (planner
    /// 20%, workers 80%) and verifies the on-chain claimant list. Removing the
    /// implicit equal-split path that used to fire here closes a footgun where
    /// per-node validation could finalize a task with the wrong reward split.
    function markValidated(bytes32 nodeId) external {
        bytes32 tid = nodes[nodeId].taskId;
        require(tid != bytes32(0), "Node not found");
        require(msg.sender == vault || msg.sender == planners[tid], "Unauthorized");

        nodes[nodeId].validated = true;
        // Worker's subtask stake is now safe to return.
        escrow.releaseSubtaskStake(tid, nodeId);
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

    /// Planner-gated explicit settlement. The planner-supplied `winners` list
    /// MUST exactly match the on-chain claimants:
    ///   winners[0]      = msg.sender (the planner itself)
    ///   winners[i+1]    = nodes[taskNodes[taskId][i]].claimedBy
    /// This prevents a malicious planner from redirecting the budget to
    /// arbitrary addresses; the contract is the single source of truth for
    /// who claimed which subtask.
    function requestSettle(
        bytes32 taskId,
        address[] calldata winners,
        uint256[] calldata amounts
    ) external {
        require(planners[taskId] == msg.sender, "Only planner");
        require(winners.length == amounts.length, "Length mismatch");

        bytes32[] memory nodeIds = taskNodes[taskId];
        require(winners.length == nodeIds.length + 1, "winners must be planner + claimants");
        require(winners[0] == msg.sender, "winners[0] must be planner");

        for (uint256 i = 0; i < nodeIds.length; i++) {
            address expected = nodes[nodeIds[i]].claimedBy;
            require(expected != address(0), "Unclaimed subtask");
            require(winners[i + 1] == expected, "winner != claimant");
        }

        escrow.settleWithAmounts(taskId, winners, amounts);
    }

    function resetNode(bytes32 nodeId) external {
        require(msg.sender == vault, "Only vault can reset");
        nodes[nodeId].claimedBy = address(0);
        nodes[nodeId].outputHash = bytes32(0);
        nodes[nodeId].validated = false;
        claimedAt[nodeId] = 0;
        emit NodeReset(nodeId);
    }

    /// Permissionless escape hatch for the "all nodes submitted but the
    /// planner-keeper never settled" failure mode. Any address can call
    /// once `lastActivityAt[taskId] + KEEPER_TIMEOUT` has elapsed —
    /// settlement uses the canonical claim list (no caller-supplied
    /// winners[] / amounts[] argument so a malicious bystander can't
    /// redirect the budget). Planner is included with amount=0 so their
    /// task-level stake is still refunded inside escrow.settleWithAmounts;
    /// they only forfeit the planner share. Workers split the budget
    /// evenly. Any rounding dust stays inside the budget (escrow tolerates
    /// totalReward <= budget).
    ///
    /// Side effects:
    ///   - Marks every node validated and releases its subtask stake
    ///     (idempotent on already-validated nodes — they just no-op).
    ///   - Calls escrow.settleWithAmounts → finalizes the task, agent
    ///     ledger entries are credited, future calls revert
    ///     "Task already finalized" so racing watchdogs are harmless.
    ///   - Emits both DAGCompleted (for off-chain consumers that already
    ///     listen to it) AND DAGForceCompleted (for explorers / metrics
    ///     that want to flag this as an unhappy-path settlement).
    function forceComplete(bytes32 taskId) external {
        bytes32[] memory nodeIds = taskNodes[taskId];
        require(nodeIds.length > 0, "Unknown task");
        uint64 stamp = lastActivityAt[taskId];
        require(stamp > 0, "No activity recorded");
        require(block.timestamp >= uint256(stamp) + KEEPER_TIMEOUT, "Keeper still has time");

        // Every node MUST have an outputHash. If a worker is still mid-
        // claim with no output, force-completing now would credit them
        // for work they never delivered. The right escape hatch for that
        // case is expireClaim() → re-claim → submit → forceComplete; we
        // don't try to do it inline because it would need the slashing
        // path too (the original claimant might have a stake locked).
        address planner = planners[taskId];
        require(planner != address(0), "No planner");

        address[] memory winners = new address[](nodeIds.length + 1);
        uint256[] memory amounts = new uint256[](nodeIds.length + 1);
        winners[0] = planner;
        amounts[0] = 0; // planner forfeits the planning bonus

        // Pull the budget straight from escrow so the share math is
        // canonical and the caller has no discretion over payouts.
        (, uint256 budget, ,) = escrow.tasks(taskId);
        require(budget > 0, "Empty budget");
        uint256 workerShare = budget / nodeIds.length;

        for (uint256 i = 0; i < nodeIds.length; i++) {
            bytes32 nid = nodeIds[i];
            DAGNode storage n = nodes[nid];
            require(n.outputHash != bytes32(0), "Node missing output");
            address claimant = n.claimedBy;
            require(claimant != address(0), "Unclaimed subtask");
            winners[i + 1] = claimant;
            amounts[i + 1] = workerShare;
            if (!n.validated) {
                n.validated = true;
                escrow.releaseSubtaskStake(taskId, nid);
            }
        }

        escrow.settleWithAmounts(taskId, winners, amounts);
        emit DAGCompleted(taskId);
        emit DAGForceCompleted(taskId, msg.sender, planner);
    }
}
