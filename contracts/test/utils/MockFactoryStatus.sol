// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {PoolId} from "v4-core/src/types/PoolId.sol";
import {PerkTypes} from "../../src/libraries/PerkTypes.sol";

/// @dev Records `setLaunchStatus` calls from BondingCurve graduation.
contract MockFactoryStatus {
    struct StatusCall {
        address meme;
        PerkTypes.LaunchStatus status;
        PoolId poolId;
    }

    StatusCall[] internal _calls;
    uint256 public pausedFlags;

    function setPaused(uint256 flags) external {
        pausedFlags = flags;
    }

    function isPaused(uint256 area) external view returns (bool) {
        return pausedFlags & area != 0;
    }

    function setLaunchStatus(address meme, PerkTypes.LaunchStatus status, PoolId poolId) external {
        _calls.push(StatusCall({meme: meme, status: status, poolId: poolId}));
    }

    function callCount() external view returns (uint256) {
        return _calls.length;
    }

    function lastCall() external view returns (StatusCall memory) {
        return _calls[_calls.length - 1];
    }

    function calls(uint256 index) external view returns (StatusCall memory) {
        return _calls[index];
    }
}
