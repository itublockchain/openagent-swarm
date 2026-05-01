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
 * @dev Decentralized challenge resolution with COMMIT-REVEAL voting.
 *
 *      Two-phase voting closes the "copy the majority" attack the old direct
 *      vote had: in the previous design, a juror could observe the running
 *      guilty/innocent counts on-chain and tail the early voters, so a single
 *      malicious early-mover effectively decided every challenge they cared
 *      about. With commit-reveal, votes stay sealed for the full commit window
 *      and only become visible during reveal — by which point no juror can
 *      change theirs.
 *
 *      Phases:
 *        commit  (COMMIT_WINDOW = 30 min):
 *           Juror submits H = keccak256(nodeId, accusedGuilty, salt, juror).
 *           Vote and salt stay off-chain. Eligibility (RUNNING agent in
 *           AgentRegistry, not accused, not challenger) checked here.
 *        reveal  (REVEAL_WINDOW = 30 min after commit closes):
 *           Juror reveals (accusedGuilty, salt). Contract recomputes hash
 *           and matches against the stored commit; first match counts.
 *        finalize (anyone, after reveal closes):
 *           Tallies revealed votes. Majority guilty → slash accused;
 *           majority innocent → slash challenger; tie or zero reveals →
 *           drop with no slashing.
 *
 *      Economic outcomes are unchanged from the v1 design:
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
        uint64  commitDeadline;
        uint64  revealDeadline;
        uint8   commitsCount;
        uint8   guiltyVotes;
        uint8   innocentVotes;
        bool    resolved;
    }

    // Demo timing — full challenge resolution must fit under 1 minute total.
    // Production deployments should restore minute-scale windows (e.g.
    // 5–10 min each) so jurors with intermittent connectivity can still
    // participate. 0G testnet block time is ~3-5s, so 20s ≈ 4-6 blocks of
    // headroom for tx propagation.
    uint256 public constant COMMIT_WINDOW            = 20 seconds;
    uint256 public constant REVEAL_WINDOW            = 20 seconds;
    uint8   public constant QUORUM                   = 3;
    /// Random jury size. Picked at challenge() time from RUNNING agents in
    /// AgentRegistry, weighted uniformly. Sized so QUORUM (3) holds even if
    /// 2/5 jurors are offline / busy / can't fetch the disputed output.
    uint8   public constant JURY_SIZE                = 5;
    uint8   public constant STATUS_RUNNING           = 1;

    uint256 public constant ACCUSED_BURN_BPS          = 8000;
    uint256 public constant CHALLENGER_REWARD_BPS     = 2000;
    uint256 public constant FALSE_CHALLENGER_BURN_BPS = 2000;

    ISwarmEscrow  public immutable escrow;
    IDAGRegistry  public immutable registry;
    AgentRegistry public immutable agents;

    mapping(bytes32 => Challenge) public challenges;
    // nodeId => juror EOA => commit hash (0x0 = no commit yet)
    mapping(bytes32 => mapping(address => bytes32)) public commits;
    // nodeId => juror EOA => 0=none, 1=guilty, 2=innocent (post-reveal)
    mapping(bytes32 => mapping(address => uint8)) public ballots;
    mapping(bytes32 => address[]) private _jurors;
    /// nodeId => juror EOA => true iff that EOA was selected as a juror at
    /// challenge() time. Limits the jury to a random JURY_SIZE-sized subset,
    /// so 25 active agents don't all spend an LLM judge() round on every
    /// challenge — only ~5 do, reading this mapping cheaply to self-filter.
    mapping(bytes32 => mapping(address => bool)) public isEligibleJuror;
    /// nodeId => list of selected jurors (for enumeration / UI display).
    mapping(bytes32 => address[]) private _eligibleJurors;

    event ChallengeRaised(
        bytes32 indexed nodeId,
        address indexed challenger,
        address indexed accused,
        uint64 commitDeadline,
        uint64 revealDeadline
    );
    event JurorsSelected(bytes32 indexed nodeId, address[] jurors);
    event VoteCommitted(bytes32 indexed nodeId, address indexed juror);
    event VoteRevealed(bytes32 indexed nodeId, address indexed juror, bool guilty);
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
        require(challenges[nodeId].commitDeadline == 0, "Challenge exists");
        require(accused != address(0), "Invalid accused");
        require(accused != msg.sender, "Cannot self-challenge");

        uint64 commitDeadline = uint64(block.timestamp + COMMIT_WINDOW);
        uint64 revealDeadline = commitDeadline + uint64(REVEAL_WINDOW);
        challenges[nodeId] = Challenge({
            nodeId: nodeId,
            challengerNodeId: challengerNodeId,
            challenger: msg.sender,
            accused: accused,
            commitDeadline: commitDeadline,
            revealDeadline: revealDeadline,
            commitsCount: 0,
            guiltyVotes: 0,
            innocentVotes: 0,
            resolved: false
        });

        // Pick the random jury at challenge time. Off-chain agents read
        // isEligibleJuror[nodeId][myAddr] right after the AXL CHALLENGE event
        // and skip judge() entirely if not picked — saves ~20 LLM calls per
        // challenge in a 25-agent swarm.
        address[] memory selected = _selectJurors(nodeId, accused, msg.sender);
        for (uint256 i = 0; i < selected.length; i++) {
            isEligibleJuror[nodeId][selected[i]] = true;
            _eligibleJurors[nodeId].push(selected[i]);
        }

        emit ChallengeRaised(nodeId, msg.sender, accused, commitDeadline, revealDeadline);
        emit JurorsSelected(nodeId, selected);
    }

    /// Pseudo-random jury selection. Seeds from prior block's hash + nodeId,
    /// rejection-samples agent indices, filters out inactive agents and the
    /// accused/challenger. Validator-influenced (the proposer of the prior
    /// block knows the seed) but acceptable on a small testnet; mainnet
    /// should swap in a VRF (Chainlink / 0G randomness when shipped).
    function _selectJurors(
        bytes32 nodeId,
        address accused,
        address challenger
    ) internal view returns (address[] memory) {
        uint256 total = agents.totalAgents();
        if (total == 0) return new address[](0);

        uint256 want = JURY_SIZE;
        if (want > total) want = total;

        address[] memory picks = new address[](want);
        uint256 picked = 0;
        bytes32 seed = keccak256(abi.encodePacked(blockhash(block.number - 1), nodeId));
        // Bound the loop so a swarm with very few RUNNING agents can't push
        // selection gas through the roof — at worst we trim the result.
        uint256 maxAttempts = total * 4 + 20;

        for (uint256 nonce = 0; nonce < maxAttempts && picked < want; nonce++) {
            uint256 idx = uint256(keccak256(abi.encodePacked(seed, nonce))) % total;
            bytes32 id = agents.allIds(idx);
            AgentRegistry.Agent memory a = agents.getAgent(id);

            if (a.status != STATUS_RUNNING) continue;
            if (a.agentAddress == address(0)) continue;
            if (a.agentAddress == accused || a.agentAddress == challenger) continue;

            bool dup = false;
            for (uint256 i = 0; i < picked; i++) {
                if (picks[i] == a.agentAddress) { dup = true; break; }
            }
            if (dup) continue;

            picks[picked++] = a.agentAddress;
        }

        if (picked == want) return picks;

        // Trim to actual count when the registry didn't have enough RUNNING
        // candidates to fill JURY_SIZE.
        address[] memory trimmed = new address[](picked);
        for (uint256 i = 0; i < picked; i++) trimmed[i] = picks[i];
        return trimmed;
    }

    /// Commit-phase: caller submits a hash of (nodeId, vote, salt, self).
    /// Eligibility is enforced via the random jury picked at challenge time;
    /// non-selected agents revert here so they can't lock up the slot.
    function commitVote(bytes32 nodeId, bytes32 commitHash) external {
        Challenge storage ch = challenges[nodeId];
        require(ch.commitDeadline != 0, "No challenge");
        require(!ch.resolved, "Already resolved");
        require(block.timestamp <= ch.commitDeadline, "Commit phase closed");
        require(isEligibleJuror[nodeId][msg.sender], "Not selected as juror");
        require(commits[nodeId][msg.sender] == bytes32(0), "Already committed");
        require(commitHash != bytes32(0), "Empty commit");

        commits[nodeId][msg.sender] = commitHash;
        ch.commitsCount++;
        emit VoteCommitted(nodeId, msg.sender);
    }

    /// Reveal-phase: caller proves their committed vote by re-computing the
    /// hash. The hash binds (nodeId, vote, salt, msg.sender), so a juror
    /// cannot retroactively flip their vote, swap salts with another juror,
    /// or replay another challenge's commit. First successful reveal counts;
    /// further reveal calls from the same juror revert.
    function revealVote(bytes32 nodeId, bool accusedGuilty, bytes32 salt) external {
        Challenge storage ch = challenges[nodeId];
        require(ch.commitDeadline != 0, "No challenge");
        require(!ch.resolved, "Already resolved");
        require(block.timestamp > ch.commitDeadline, "Reveal phase not open");
        require(block.timestamp <= ch.revealDeadline, "Reveal phase closed");
        require(ballots[nodeId][msg.sender] == 0, "Already revealed");

        bytes32 stored = commits[nodeId][msg.sender];
        require(stored != bytes32(0), "No commit");
        bytes32 expected = keccak256(abi.encodePacked(nodeId, accusedGuilty, salt, msg.sender));
        require(stored == expected, "Reveal mismatch");

        ballots[nodeId][msg.sender] = accusedGuilty ? 1 : 2;
        _jurors[nodeId].push(msg.sender);
        if (accusedGuilty) {
            ch.guiltyVotes++;
        } else {
            ch.innocentVotes++;
        }
        emit VoteRevealed(nodeId, msg.sender, accusedGuilty);
    }

    /// After the reveal window closes, anyone can sweep. Majority of
    /// revealed votes wins; ties default to innocent (presumed innocent rule).
    /// Zero reveals drops the challenge without slashing either party.
    /// Note: in v1 this also auto-fired once QUORUM votes had landed mid-window.
    /// Auto-resolution is incompatible with sealed votes — by definition we
    /// cannot tally guilty/innocent without revealed votes, so the only
    /// safe time to resolve is after the reveal deadline.
    function finalize(bytes32 nodeId) external {
        Challenge storage ch = challenges[nodeId];
        require(ch.commitDeadline != 0, "No challenge");
        require(!ch.resolved, "Already resolved");
        require(block.timestamp > ch.revealDeadline, "Reveal still open");

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

    function getEligibleJurors(bytes32 nodeId) external view returns (address[] memory) {
        return _eligibleJurors[nodeId];
    }
}
