// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Currency} from "v4-core/src/types/Currency.sol";

/// @title IPerkCommunityTreasury
/// @notice Fixed-rule receiver of quote assets (PRD 6.10). No instant admin withdrawal.
/// @dev The only outflow is a whole-balance migration of one currency, after `timelock()`, to whatever non-zero address
///      the owner proposed. The address is not restricted: it may be a successor contract, a multisig or any other
///      account, so the timelock (and the public MigrationProposed event it follows) is the protection.
interface IPerkCommunityTreasury {
    event Received(Currency indexed quote, address indexed from, uint256 amount, bytes32 indexed ref);
    event MigrationProposed(Currency indexed quote, address indexed to, uint256 executeAfter);
    event MigrationCancelled(Currency indexed quote);
    event MigrationExecuted(Currency indexed quote, address indexed to, uint256 amount);

    error NativeAmountMismatch();
    error NoPendingMigration();
    error TimelockNotElapsed(uint256 executeAfter);
    error ZeroAddress();

    function timelock() external view returns (uint256);

    /// @notice Deposit with a traceability ref (launchId or grant positionId, PRD 12.6).
    /// @dev Native: msg.value == amount. ERC-20: pulled via transferFrom(msg.sender).
    function deposit(Currency quote, uint256 amount, bytes32 ref) external payable;

    /// @notice Owner only. Proposes moving the whole balance of `quote` to `to` (any non-zero address) once the
    ///         timelock has passed; re-proposing replaces the pending migration and restarts the timelock.
    function proposeMigration(Currency quote, address to) external;
    /// @notice Owner only. Withdraws the pending migration of `quote`.
    function cancelMigration(Currency quote) external;
    /// @notice Anyone, after the timelock: sends the whole current balance of `quote` to the proposed address.
    function executeMigration(Currency quote) external;

    function pendingMigration(Currency quote) external view returns (address to, uint256 executeAfter);
    function balance(Currency quote) external view returns (uint256);
}
