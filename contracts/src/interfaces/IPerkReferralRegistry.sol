// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/// @title IPerkReferralRegistry
/// @notice Platform-level referral binding and grant opt-in (PRD 6.3, ADR-008).
/// @dev Simplifications versus PRD 6.3 (ADR-008):
///      - no "first qualified write operation" rule: binding is allowed at any time; a relationship only counts for a
///        launch when `boundAtBlock` is at or before that launch's snapshot cutoff block (its graduation block);
///      - `optIn` records the block a wallet asked to be included in future TWAB snapshots (native-quote launches use
///        the opt-in set as the eligible population, see packages/indexer/DESIGN.md).
interface IPerkReferralRegistry {
    event InviterBound(address indexed invitee, address indexed inviter, uint64 blockNumber);
    event OptedIn(address indexed account, uint64 blockNumber);

    error AlreadyBound();
    error SelfReferral();
    error MutualReferral();
    error ZeroAddress();

    /// @notice Binds msg.sender to `inviter` permanently. Rejects self, zero, repeat binding and A<->B loops.
    function bindInviter(address inviter) external;

    /// @notice Records msg.sender as a grant-snapshot participant. Idempotent (keeps the first block).
    function optIn() external;

    /// @notice Opt in and bind `inviter` in one transaction (the invite-link flow). Binding follows the same rules as
    ///         `bindInviter` and reverts the whole call on failure; an existing opt-in keeps its original block.
    function optInWithInviter(address inviter) external;

    function inviterOf(address invitee) external view returns (address inviter);
    function boundAtBlock(address invitee) external view returns (uint64 blockNumber);
    function optInBlock(address account) external view returns (uint64 blockNumber);

    /// @notice True when `invitee` had `inviter` bound at or before `cutoffBlock`.
    function isBoundBy(address invitee, address inviter, uint64 cutoffBlock) external view returns (bool);
}
