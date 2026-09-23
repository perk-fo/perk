// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

// Compiles GraduationManager under its own 200-runs profile (foundry.toml compilation_restrictions) so that
// `vm.getCode("GraduationManager.sol:GraduationManager")` finds an artifact that fits under EIP-170. Nothing else may
// import GraduationManager.sol directly: everyone talks to it through IPerkGraduationManager.
import {GraduationManager} from "../../src/graduation/GraduationManager.sol";
