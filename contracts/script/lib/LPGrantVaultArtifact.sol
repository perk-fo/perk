// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

// Compiles LPGrantVault under its own 200-runs profile (foundry.toml compilation_restrictions) so that
// `vm.getCode("LPGrantVault.sol:LPGrantVault")` finds an artifact that fits under EIP-170. Nothing else may import
// LPGrantVault.sol directly: everyone talks to it through IPerkLPGrantVault.
import {LPGrantVault} from "../../src/grant/LPGrantVault.sol";
