// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Currency, CurrencyLibrary} from "v4-core/src/types/Currency.sol";
import {IPerkCommunityTreasury} from "../interfaces/IPerkCommunityTreasury.sol";

/// @title CommunityTreasury
/// @notice Fixed-rule receiver of quote assets (and of the meme fees of the locked initial positions). The only
///         outflow is a whole-balance migration, after a timelock, to any non-zero address the owner proposes.
contract CommunityTreasury is IPerkCommunityTreasury, Ownable2Step {
    using SafeERC20 for IERC20;
    using CurrencyLibrary for Currency;

    struct Migration {
        address to;
        uint256 executeAfter;
    }

    /// @inheritdoc IPerkCommunityTreasury
    uint256 public immutable override timelock;

    mapping(Currency quote => Migration) private _pending;

    /// @param owner_ Two-step Ownable owner.
    /// @param timelockSeconds Delay between `proposeMigration` and `executeMigration`.
    constructor(address owner_, uint256 timelockSeconds) Ownable(owner_) {
        timelock = timelockSeconds;
    }

    /// @notice Accepts native quote with no calldata. `ref` is zero because there is no deposit context.
    receive() external payable {
        emit Received(CurrencyLibrary.ADDRESS_ZERO, msg.sender, msg.value, bytes32(0));
    }

    /// @inheritdoc IPerkCommunityTreasury
    function deposit(Currency quote, uint256 amount, bytes32 ref) external payable {
        if (quote.isAddressZero()) {
            if (msg.value != amount) revert NativeAmountMismatch();
        } else {
            if (msg.value != 0) revert NativeAmountMismatch();
            IERC20(Currency.unwrap(quote)).safeTransferFrom(msg.sender, address(this), amount);
        }
        emit Received(quote, msg.sender, amount, ref);
    }

    /// @inheritdoc IPerkCommunityTreasury
    function proposeMigration(Currency quote, address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 executeAfter = block.timestamp + timelock;
        _pending[quote] = Migration({to: to, executeAfter: executeAfter});
        emit MigrationProposed(quote, to, executeAfter);
    }

    /// @inheritdoc IPerkCommunityTreasury
    function cancelMigration(Currency quote) external onlyOwner {
        if (_pending[quote].to == address(0)) revert NoPendingMigration();
        delete _pending[quote];
        emit MigrationCancelled(quote);
    }

    /// @inheritdoc IPerkCommunityTreasury
    function executeMigration(Currency quote) external {
        Migration memory pending_ = _pending[quote];
        if (pending_.to == address(0)) revert NoPendingMigration();
        // Timelock is the intended delay; validator timestamp skew cannot shorten it below executeAfter.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < pending_.executeAfter) revert TimelockNotElapsed(pending_.executeAfter);

        uint256 amount = quote.balanceOfSelf();
        delete _pending[quote];
        emit MigrationExecuted(quote, pending_.to, amount);
        CurrencyLibrary.transfer(quote, pending_.to, amount);
    }

    /// @inheritdoc IPerkCommunityTreasury
    function pendingMigration(Currency quote) external view returns (address to, uint256 executeAfter) {
        Migration storage pending_ = _pending[quote];
        return (pending_.to, pending_.executeAfter);
    }

    /// @inheritdoc IPerkCommunityTreasury
    function balance(Currency quote) external view returns (uint256) {
        return quote.balanceOfSelf();
    }
}
