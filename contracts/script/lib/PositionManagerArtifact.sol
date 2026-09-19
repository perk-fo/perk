// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

// Compiles v4-periphery's PositionManager under its own 500-runs profile (see foundry.toml compilation_restrictions)
// so that `vm.getCode("PositionManager.sol:PositionManager")` finds the artifact. Nothing else may import
// PositionManager.sol directly: an importer that also reaches PoolManager.sol would drag PoolManager into the
// 500-runs job, where Pool.swap no longer compiles.
import {PositionManager} from "v4-periphery/src/PositionManager.sol";
