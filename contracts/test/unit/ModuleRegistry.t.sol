// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IPerkModuleRegistry} from "../../src/interfaces/IPerkModuleRegistry.sol";
import {PerkConstants} from "../../src/libraries/PerkConstants.sol";
import {PerkTypes} from "../../src/libraries/PerkTypes.sol";
import {ModuleRegistry} from "../../src/registry/ModuleRegistry.sol";

contract ModuleRegistryTest is Test {
    ModuleRegistry internal registry;
    address internal stranger;
    Currency internal quote;

    event ModuleRegistered(bytes32 indexed moduleId, uint32 indexed version, uint256 bit, PerkTypes.ModuleInfo info);
    event ModuleStatusUpdated(bytes32 indexed moduleId, uint32 indexed version, PerkTypes.RegistryStatus status);
    event ModuleQuoteCompatibilityUpdated(
        bytes32 indexed moduleId, uint32 indexed version, Currency indexed quote, bool ok
    );

    function setUp() public {
        stranger = makeAddr("stranger");
        quote = Currency.wrap(address(0));
        registry = new ModuleRegistry(address(this));
        _registerV1();
    }

    function test_registerModule_fiveV1Modules() public view {
        _assertBit(
            PerkConstants.MODULE_OFFICIAL_POOL_GUARD_V1,
            PerkConstants.MODULE_ID_OFFICIAL_POOL_GUARD,
            PerkTypes.ModuleType.HOOK
        );
        _assertBit(
            PerkConstants.MODULE_QUOTE_FEE_ROUTER_V1,
            PerkConstants.MODULE_ID_QUOTE_FEE_ROUTER,
            PerkTypes.ModuleType.HOOK
        );
        _assertBit(
            PerkConstants.MODULE_HOLDER_QUOTE_REWARD_V1,
            PerkConstants.MODULE_ID_HOLDER_QUOTE_REWARD,
            PerkTypes.ModuleType.HOOK
        );
        _assertBit(PerkConstants.MODULE_LP_GRANT_V1, PerkConstants.MODULE_ID_LP_GRANT, PerkTypes.ModuleType.GROWTH);
        _assertBit(
            PerkConstants.MODULE_REFERRAL_GRANT_BOOST_V1,
            PerkConstants.MODULE_ID_REFERRAL_GRANT_BOOST,
            PerkTypes.ModuleType.GROWTH
        );
    }

    function test_registerModule_reverts_duplicateIdVersion() public {
        vm.expectRevert(IPerkModuleRegistry.ModuleExists.selector);
        registry.registerModule(
            _v1(PerkConstants.MODULE_ID_LP_GRANT, PerkConstants.MODULE_LP_GRANT_V1, PerkTypes.ModuleType.GROWTH)
        );
    }

    function test_registerModule_reverts_bitCollision() public {
        PerkTypes.ModuleInfo memory info =
            _v1(keccak256("OTHER"), PerkConstants.MODULE_LP_GRANT_V1, PerkTypes.ModuleType.GROWTH);
        vm.expectRevert(abi.encodeWithSelector(IPerkModuleRegistry.BitTaken.selector, info.bit));
        registry.registerModule(info);
    }

    function test_registerModule_reverts_multiBit() public {
        PerkTypes.ModuleInfo memory info = _v1(keccak256("MULTI"), 3, PerkTypes.ModuleType.LAUNCH);
        vm.expectRevert(IPerkModuleRegistry.InvalidBit.selector);
        registry.registerModule(info);
    }

    function test_validateCompatibility_happyPathAfterWhitelist() public {
        uint256 bitmap = PerkConstants.CORE_MODULES_V1 | PerkConstants.MODULE_LP_GRANT_V1
            | PerkConstants.MODULE_REFERRAL_GRANT_BOOST_V1;
        (bool okBefore,) = registry.validateCompatibility(bitmap, quote);
        assertFalse(okBefore);

        _whitelistV1(quote);

        (bool ok, string memory reason) = registry.validateCompatibility(bitmap, quote);
        assertTrue(ok);
        assertEq(reason, "");
    }

    function test_validateCompatibility_unknownModule() public {
        _whitelistV1(quote);
        (bool ok, string memory reason) =
            registry.validateCompatibility(PerkConstants.CORE_MODULES_V1 | (uint256(1) << 5), quote);
        assertFalse(ok);
        assertEq(reason, "unknown module");
    }

    function test_validateCompatibility_moduleNotActive() public {
        _whitelistV1(quote);
        registry.setModuleStatus(PerkConstants.MODULE_ID_QUOTE_FEE_ROUTER, 1, PerkTypes.RegistryStatus.DEPRECATED);
        (bool ok, string memory reason) = registry.validateCompatibility(PerkConstants.CORE_MODULES_V1, quote);
        assertFalse(ok);
        assertEq(reason, "module not active");
    }

    function test_validateCompatibility_quoteIncompatible() public view {
        (bool ok, string memory reason) = registry.validateCompatibility(PerkConstants.CORE_MODULES_V1, quote);
        assertFalse(ok);
        assertEq(reason, "quote incompatible");
    }

    function test_validateCompatibility_moduleConflict() public {
        PerkTypes.ModuleInfo memory info = _v1(keccak256("CONFLICT"), uint256(1) << 5, PerkTypes.ModuleType.LAUNCH);
        info.incompatibleModules = PerkConstants.MODULE_OFFICIAL_POOL_GUARD_V1;
        registry.registerModule(info);
        _whitelistV1(quote);
        registry.setQuoteCompatibility(info.moduleId, info.version, quote, true);

        (bool ok, string memory reason) =
            registry.validateCompatibility(PerkConstants.CORE_MODULES_V1 | info.bit, quote);
        assertFalse(ok);
        assertEq(reason, "module conflict");
    }

    function test_setModuleStatus_onlyOwner_and_ModuleNotFound() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        registry.setModuleStatus(PerkConstants.MODULE_ID_LP_GRANT, 1, PerkTypes.RegistryStatus.CANARY);

        vm.expectRevert(IPerkModuleRegistry.ModuleNotFound.selector);
        registry.setModuleStatus(keccak256("missing"), 1, PerkTypes.RegistryStatus.ACTIVE);
    }

    function test_setQuoteCompatibility_onlyOwner_and_ModuleNotFound() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        registry.setQuoteCompatibility(PerkConstants.MODULE_ID_LP_GRANT, 1, quote, true);

        vm.expectRevert(IPerkModuleRegistry.ModuleNotFound.selector);
        registry.setQuoteCompatibility(keccak256("missing"), 1, quote, true);
    }

    function test_moduleByBit_reverts_ModuleNotFound() public {
        vm.expectRevert(IPerkModuleRegistry.ModuleNotFound.selector);
        registry.moduleByBit(uint256(1) << 10);
    }

    function test_isModuleActive_togglesWithStatus() public {
        assertTrue(registry.isModuleActive(PerkConstants.MODULE_ID_LP_GRANT, 1));
        registry.setModuleStatus(PerkConstants.MODULE_ID_LP_GRANT, 1, PerkTypes.RegistryStatus.DEPRECATED);
        assertFalse(registry.isModuleActive(PerkConstants.MODULE_ID_LP_GRANT, 1));
        assertFalse(registry.isModuleActive(keccak256("missing"), 1));
    }

    function _registerV1() internal {
        registry.registerModule(
            _v1(
                PerkConstants.MODULE_ID_OFFICIAL_POOL_GUARD,
                PerkConstants.MODULE_OFFICIAL_POOL_GUARD_V1,
                PerkTypes.ModuleType.HOOK
            )
        );
        registry.registerModule(
            _v1(
                PerkConstants.MODULE_ID_QUOTE_FEE_ROUTER,
                PerkConstants.MODULE_QUOTE_FEE_ROUTER_V1,
                PerkTypes.ModuleType.HOOK
            )
        );
        registry.registerModule(
            _v1(
                PerkConstants.MODULE_ID_HOLDER_QUOTE_REWARD,
                PerkConstants.MODULE_HOLDER_QUOTE_REWARD_V1,
                PerkTypes.ModuleType.HOOK
            )
        );
        registry.registerModule(
            _v1(PerkConstants.MODULE_ID_LP_GRANT, PerkConstants.MODULE_LP_GRANT_V1, PerkTypes.ModuleType.GROWTH)
        );
        registry.registerModule(
            _v1(
                PerkConstants.MODULE_ID_REFERRAL_GRANT_BOOST,
                PerkConstants.MODULE_REFERRAL_GRANT_BOOST_V1,
                PerkTypes.ModuleType.GROWTH
            )
        );
    }

    function _whitelistV1(Currency q) internal {
        registry.setQuoteCompatibility(PerkConstants.MODULE_ID_OFFICIAL_POOL_GUARD, 1, q, true);
        registry.setQuoteCompatibility(PerkConstants.MODULE_ID_QUOTE_FEE_ROUTER, 1, q, true);
        registry.setQuoteCompatibility(PerkConstants.MODULE_ID_HOLDER_QUOTE_REWARD, 1, q, true);
        registry.setQuoteCompatibility(PerkConstants.MODULE_ID_LP_GRANT, 1, q, true);
        registry.setQuoteCompatibility(PerkConstants.MODULE_ID_REFERRAL_GRANT_BOOST, 1, q, true);
    }

    function _v1(bytes32 moduleId, uint256 bit, PerkTypes.ModuleType moduleType)
        internal
        pure
        returns (PerkTypes.ModuleInfo memory)
    {
        return PerkTypes.ModuleInfo({
            moduleId: moduleId,
            version: 1,
            moduleType: moduleType,
            bit: bit,
            hookPermissionBitmap: 0,
            runtimeCodeHash: bytes32(uint256(1)),
            sourceCommit: "v1",
            incompatibleModules: 0,
            status: PerkTypes.RegistryStatus.ACTIVE
        });
    }

    function _assertBit(uint256 bit, bytes32 moduleId, PerkTypes.ModuleType moduleType) internal view {
        PerkTypes.ModuleInfo memory info = registry.moduleByBit(bit);
        assertEq(info.moduleId, moduleId);
        assertEq(info.version, 1);
        assertEq(uint256(info.moduleType), uint256(moduleType));
        assertEq(info.bit, bit);
        assertTrue(registry.isModuleActive(moduleId, 1));
    }
}
