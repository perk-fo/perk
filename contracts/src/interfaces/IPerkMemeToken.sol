// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @title IPerkMemeToken
/// @notice Fixed-supply ERC-20 whose every balance change is checkpointed in the HolderRewardDistributor.
/// @dev Constructor mints `totalSupply` to `msg.sender` (the LaunchFactory), which then distributes it.
///      There is no mint after construction and no owner.
interface IPerkMemeToken is IERC20, IERC20Metadata {
    /// @notice Emitted when the distributor checkpoint call reverted and was swallowed (ADR-003).
    event RewardCheckpointFailed(address indexed account, uint256 oldBalance, uint256 newBalance);

    function factory() external view returns (address);
    function distributor() external view returns (address);
    function tokenURI() external view returns (string memory);

    /// @notice Burns caller's tokens. Used by LPGrantVault and GraduationManager for their own balances.
    function burn(uint256 amount) external;
}
