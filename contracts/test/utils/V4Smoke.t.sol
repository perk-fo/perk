// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";

/// @dev Sanity check that v4-core test utilities compile and deploy under this repo's settings.
contract V4SmokeTest is Test, Deployers {
    function test_deployPoolManager() public {
        deployFreshManagerAndRouters();
        assertTrue(address(manager) != address(0));
        assertTrue(address(manager).code.length > 0);
    }
}
