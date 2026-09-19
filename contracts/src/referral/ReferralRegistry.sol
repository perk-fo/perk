// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IPerkReferralRegistry} from "../interfaces/IPerkReferralRegistry.sol";

/// @title ReferralRegistry
/// @notice Permanent single-inviter binding plus grant opt-in. No owner, no admin path (PRD 6.3, ADR-008).
contract ReferralRegistry is IPerkReferralRegistry {
    mapping(address invitee => address inviter) private _inviterOf;
    mapping(address invitee => uint64 blockNumber) private _boundAt;
    mapping(address account => uint64 blockNumber) private _optInAt;

    /// @inheritdoc IPerkReferralRegistry
    function bindInviter(address inviter) external {
        _bind(msg.sender, inviter);
    }

    /// @inheritdoc IPerkReferralRegistry
    function optIn() external {
        _optIn(msg.sender);
    }

    /// @inheritdoc IPerkReferralRegistry
    function optInWithInviter(address inviter) external {
        _bind(msg.sender, inviter);
        _optIn(msg.sender);
    }

    /// @inheritdoc IPerkReferralRegistry
    function inviterOf(address invitee) external view returns (address) {
        return _inviterOf[invitee];
    }

    /// @inheritdoc IPerkReferralRegistry
    function boundAtBlock(address invitee) external view returns (uint64) {
        return _boundAt[invitee];
    }

    /// @inheritdoc IPerkReferralRegistry
    function optInBlock(address account) external view returns (uint64) {
        return _optInAt[account];
    }

    /// @inheritdoc IPerkReferralRegistry
    function isBoundBy(address invitee, address inviter, uint64 cutoffBlock) external view returns (bool) {
        return inviter != address(0) && _inviterOf[invitee] == inviter && _boundAt[invitee] <= cutoffBlock;
    }

    function _bind(address invitee, address inviter) private {
        if (inviter == address(0)) revert ZeroAddress();
        if (inviter == invitee) revert SelfReferral();
        if (_inviterOf[invitee] != address(0)) revert AlreadyBound();
        if (_inviterOf[inviter] == invitee) revert MutualReferral();
        _inviterOf[invitee] = inviter;
        // block.number fits comfortably in uint64
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 bn = uint64(block.number);
        _boundAt[invitee] = bn;
        emit InviterBound(invitee, inviter, bn);
    }

    function _optIn(address account) private {
        if (_optInAt[account] != 0) return;
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 bn = uint64(block.number);
        _optInAt[account] = bn;
        emit OptedIn(account, bn);
    }
}
