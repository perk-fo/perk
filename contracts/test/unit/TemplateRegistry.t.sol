// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IPerkTemplateRegistry} from "../../src/interfaces/IPerkTemplateRegistry.sol";
import {PerkConstants} from "../../src/libraries/PerkConstants.sol";
import {PerkTemplates} from "../../src/libraries/PerkTemplates.sol";
import {PerkTypes} from "../../src/libraries/PerkTypes.sol";
import {TemplateRegistry} from "../../src/registry/TemplateRegistry.sol";

contract TemplateRegistryTest is Test {
    TemplateRegistry internal registry;
    address internal stranger;
    Currency internal quote;

    event TemplateRegistered(bytes32 indexed templateId, PerkTypes.Template template);
    event TemplateStatusUpdated(bytes32 indexed templateId, PerkTypes.RegistryStatus status);

    function setUp() public {
        stranger = makeAddr("stranger");
        quote = Currency.wrap(address(0));
        registry = new TemplateRegistry(address(this));
    }

    function test_registerTemplate_perkAndStandardV1() public {
        PerkTemplates.Numbers memory n = PerkTemplates.defaultNumbers();
        PerkTypes.Template memory perk = PerkTemplates.perkGrantV1(n);
        PerkTypes.Template memory standard = PerkTemplates.standardCurveV1(n);

        vm.expectEmit(true, false, false, true, address(registry));
        emit TemplateRegistered(PerkConstants.TEMPLATE_PERK_GRANT_V1, perk);
        registry.registerTemplate(PerkConstants.TEMPLATE_PERK_GRANT_V1, perk);

        vm.expectEmit(true, false, false, true, address(registry));
        emit TemplateRegistered(PerkConstants.TEMPLATE_STANDARD_CURVE_V1, standard);
        registry.registerTemplate(PerkConstants.TEMPLATE_STANDARD_CURVE_V1, standard);

        assertEq(abi.encode(registry.getTemplate(PerkConstants.TEMPLATE_PERK_GRANT_V1)), abi.encode(perk));
        assertEq(abi.encode(registry.getTemplate(PerkConstants.TEMPLATE_STANDARD_CURVE_V1)), abi.encode(standard));
        assertTrue(registry.isActive(PerkConstants.TEMPLATE_PERK_GRANT_V1));
        assertTrue(registry.isActive(PerkConstants.TEMPLATE_STANDARD_CURVE_V1));
    }

    function test_registerTemplate_reverts_TemplateExists() public {
        registry.registerTemplate(PerkConstants.TEMPLATE_PERK_GRANT_V1, _perk());
        vm.expectRevert(IPerkTemplateRegistry.TemplateExists.selector);
        registry.registerTemplate(PerkConstants.TEMPLATE_PERK_GRANT_V1, _perk());
    }

    function test_registerTemplate_reverts_feeSplit() public {
        PerkTypes.Template memory t = _perk();
        t.feeSplit.protocolBps = 0;
        _expectInvalid("fee split");
        registry.registerTemplate(bytes32("bad"), t);
    }

    function test_registerTemplate_reverts_totalFee() public {
        PerkTypes.Template memory t = _perk();
        t.totalFeeBps = 0;
        _expectInvalid("total fee");
        registry.registerTemplate(bytes32("bad"), t);
    }

    function test_registerTemplate_reverts_lpFeePips() public {
        PerkTypes.Template memory t = _perk();
        t.pool.lpFee = 1;
        _expectInvalid("lp fee pips");
        registry.registerTemplate(bytes32("bad"), t);
    }

    function test_registerTemplate_reverts_supplySum() public {
        PerkTypes.Template memory t = _perk();
        t.supply.curveSupply += 1;
        _expectInvalid("supply sum");
        registry.registerTemplate(bytes32("bad"), t);
    }

    function test_registerTemplate_reverts_grantReserve() public {
        PerkTypes.Template memory t = _perk();
        t.supply.grantReserveSupply -= 1;
        t.supply.poolReserveSupply += 1;
        _expectInvalid("grant reserve");
        registry.registerTemplate(bytes32("bad"), t);
    }

    function test_registerTemplate_reverts_grantParams() public {
        PerkTypes.Template memory t = _perk();
        t.grant.baseGrantPoolBps = 7000;
        _expectInvalid("grant params");
        registry.registerTemplate(bytes32("bad"), t);
    }

    function test_registerTemplate_reverts_coreModules() public {
        PerkTypes.Template memory t = _perk();
        t.moduleBitmap &= ~PerkConstants.MODULE_OFFICIAL_POOL_GUARD_V1;
        _expectInvalid("core modules");
        registry.registerTemplate(bytes32("bad"), t);
    }

    function test_registerTemplate_reverts_grantModuleBit() public {
        PerkTypes.Template memory t = _perk();
        t.moduleBitmap &= ~PerkConstants.MODULE_LP_GRANT_V1;
        _expectInvalid("grant module bit");
        registry.registerTemplate(bytes32("bad"), t);
    }

    function test_registerTemplate_reverts_referralModuleBit() public {
        PerkTypes.Template memory t = _perk();
        t.moduleBitmap &= ~PerkConstants.MODULE_REFERRAL_GRANT_BOOST_V1;
        _expectInvalid("referral module bit");
        registry.registerTemplate(bytes32("bad"), t);
    }

    function test_registerTemplate_reverts_unknownModuleBit() public {
        PerkTypes.Template memory t = _perk();
        t.moduleBitmap |= uint256(1) << 5;
        _expectInvalid("unknown module bit");
        registry.registerTemplate(bytes32("bad"), t);
    }

    function test_registerTemplate_reverts_curveParams() public {
        PerkTypes.Template memory t = _perk();
        t.curve.virtualQuoteReserve = 0;
        _expectInvalid("curve params");
        registry.registerTemplate(bytes32("bad"), t);
    }

    function test_registerTemplate_reverts_curveOverflow() public {
        PerkTypes.Template memory t = _perk();
        uint256 sold = registry.memeSoldAtGraduation(t);
        t.supply.poolReserveSupply += t.supply.curveSupply - (sold - 1);
        t.supply.curveSupply = sold - 1;
        _expectInvalid("curve overflow");
        registry.registerTemplate(bytes32("bad"), t);
    }

    function test_registerTemplate_reverts_ticks() public {
        PerkTypes.Template memory t = _perk();
        t.pool.tickSpacing = 0;
        _expectInvalid("ticks");
        registry.registerTemplate(bytes32("bad"), t);
    }

    function test_registerTemplate_reverts_minEligible() public {
        PerkTypes.Template memory t = _perk();
        t.minEligibleBalance = 0;
        _expectInvalid("min eligible");
        registry.registerTemplate(bytes32("bad"), t);
    }

    function test_registerTemplate_reverts_hookVersion() public {
        PerkTypes.Template memory t = _perk();
        t.hookVersion = 0;
        _expectInvalid("hook version");
        registry.registerTemplate(bytes32("bad"), t);
    }

    function test_memeSoldAtGraduation_and_finalPriceX18_defaultNumbers() public view {
        PerkTypes.Template memory t = _perk();
        uint256 sold = registry.memeSoldAtGraduation(t);
        uint256 expectedSold = Math.mulDiv(
            t.curve.virtualMemeReserve,
            t.curve.graduationQuoteThreshold,
            t.curve.virtualQuoteReserve + t.curve.graduationQuoteThreshold
        );
        assertEq(sold, expectedSold);
        assertLt(sold, t.supply.curveSupply);

        uint256 price = registry.finalPriceX18(t);
        uint256 expectedPrice = Math.mulDiv(
            t.curve.virtualQuoteReserve + t.curve.graduationQuoteThreshold, 1e18, t.curve.virtualMemeReserve - sold
        );
        assertEq(price, expectedPrice);

        uint256 approx = Math.mulDiv(115e18, 1e18, 23_793e22);
        assertApproxEqRel(price, approx, 0.01e18);
    }

    function test_setTemplateStatus_onlyOwner_and_togglesIsActive() public {
        bytes32 id = PerkConstants.TEMPLATE_PERK_GRANT_V1;
        registry.registerTemplate(id, _perk());
        assertTrue(registry.isActive(id));

        vm.expectEmit(true, false, false, true, address(registry));
        emit TemplateStatusUpdated(id, PerkTypes.RegistryStatus.CANARY);
        registry.setTemplateStatus(id, PerkTypes.RegistryStatus.CANARY);
        assertFalse(registry.isActive(id));
        assertEq(uint256(registry.getTemplate(id).status), uint256(PerkTypes.RegistryStatus.CANARY));

        registry.setTemplateStatus(id, PerkTypes.RegistryStatus.ACTIVE);
        assertTrue(registry.isActive(id));

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        registry.setTemplateStatus(id, PerkTypes.RegistryStatus.DEPRECATED);
    }

    function test_setTemplateStatus_reverts_TemplateNotFound() public {
        vm.expectRevert(IPerkTemplateRegistry.TemplateNotFound.selector);
        registry.setTemplateStatus(bytes32("missing"), PerkTypes.RegistryStatus.ACTIVE);
    }

    function test_validateConfiguration_returnsBitmapAndHash() public {
        bytes32 id = PerkConstants.TEMPLATE_PERK_GRANT_V1;
        PerkTypes.Template memory t = _perk();
        registry.registerTemplate(id, t);

        (uint256 bitmap, bytes32 hash_) = registry.validateConfiguration(id, quote, "");
        assertEq(bitmap, t.moduleBitmap);
        assertEq(hash_, keccak256(""));
    }

    function test_validateConfiguration_reverts_nonEmptyParams() public {
        bytes32 id = PerkConstants.TEMPLATE_PERK_GRANT_V1;
        registry.registerTemplate(id, _perk());
        vm.expectRevert(IPerkTemplateRegistry.ModuleParamsNotSupported.selector);
        registry.validateConfiguration(id, quote, hex"01");
    }

    function test_validateConfiguration_reverts_TemplateNotFound() public {
        vm.expectRevert(IPerkTemplateRegistry.TemplateNotFound.selector);
        registry.validateConfiguration(bytes32("missing"), quote, "");
    }

    function _perk() internal pure returns (PerkTypes.Template memory) {
        return PerkTemplates.perkGrantV1(PerkTemplates.defaultNumbers());
    }

    function _expectInvalid(string memory reason) internal {
        vm.expectRevert(abi.encodeWithSelector(IPerkTemplateRegistry.InvalidTemplate.selector, reason));
    }
}
