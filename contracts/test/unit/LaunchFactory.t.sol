// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/Vm.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";

import {LaunchFactory} from "../../src/factory/LaunchFactory.sol";
import {IPerkLaunchFactory} from "../../src/interfaces/IPerkLaunchFactory.sol";
import {IPerkTemplateRegistry} from "../../src/interfaces/IPerkTemplateRegistry.sol";
import {IPerkBondingCurve} from "../../src/interfaces/IPerkBondingCurve.sol";
import {IPerkFeeRouter} from "../../src/interfaces/IPerkFeeRouter.sol";
import {PerkMemeToken} from "../../src/token/PerkMemeToken.sol";
import {PerkConstants} from "../../src/libraries/PerkConstants.sol";
import {PerkTemplates} from "../../src/libraries/PerkTemplates.sol";
import {PerkTypes} from "../../src/libraries/PerkTypes.sol";
import {PerkDeployer} from "../utils/PerkDeployer.sol";
import {MockERC20} from "../utils/MockERC20.sol";

contract LaunchFactoryTest is PerkDeployer {
    bytes32 internal constant SALT = keccak256("salt-1");
    bytes32 internal constant TINY_TEMPLATE = keccak256("TINY_THRESHOLD_V1");
    uint256 internal constant DEV_BUY = 1 ether;

    Topology internal t;
    address internal creator;
    address internal stranger;
    address internal vault;

    event LaunchCreated(
        bytes32 indexed launchId,
        address indexed meme,
        address indexed creator,
        Currency quote,
        bytes32 templateId,
        bytes32 configHash
    );
    event LaunchTemplateSelected(
        bytes32 indexed launchId,
        bytes32 indexed templateId,
        uint32 hookVersion,
        uint256 moduleBitmap,
        bytes32 moduleParamsHash
    );
    event HookModulesCommitted(
        bytes32 indexed launchId, address indexed hook, uint256 moduleBitmap, bytes32 configHash
    );
    event LaunchStatusUpdated(address indexed meme, PerkTypes.LaunchStatus status, PoolId poolId);
    event DevBuyExecuted(address indexed meme, address indexed creator, uint256 quoteIn, uint256 memeOut);

    event ReleaseProposed(address indexed meme, address indexed to, uint256 executeAfter);
    event ReleaseCancelled(address indexed meme);
    event ReleaseExecuted(address indexed meme, address indexed to, uint256 amount);

    function setUp() public {
        creator = makeAddr("creator");
        stranger = makeAddr("stranger");
        vault = makeAddr("vault");
        vm.deal(creator, 1000 ether);
        t = deployPerkV1(address(this), makeAddr("poolManager"));
        t.quoteToken.mint(creator, 1_000_000 ether);
        vm.prank(creator);
        t.quoteToken.approve(address(t.factory), type(uint256).max);
    }

    // -------------------------------------------------------------------------
    // previewLaunch reverts
    // -------------------------------------------------------------------------

    function test_previewLaunch_reverts_inactiveTemplate() public {
        t.templateRegistry.setTemplateStatus(PerkConstants.TEMPLATE_PERK_GRANT_V1, PerkTypes.RegistryStatus.DEPRECATED);
        PerkTypes.CreateLaunchParams memory p = _base(PerkConstants.TEMPLATE_PERK_GRANT_V1, t.erc20Quote, SALT, 0);
        vm.prank(creator);
        vm.expectRevert(IPerkLaunchFactory.TemplateNotActive.selector);
        t.factory.previewLaunch(p);
    }

    function test_previewLaunch_reverts_disallowedQuote() public {
        MockERC20 bad = new MockERC20("Bad", "BAD", 18);
        PerkTypes.CreateLaunchParams memory p =
            _base(PerkConstants.TEMPLATE_PERK_GRANT_V1, Currency.wrap(address(bad)), SALT, 0);
        vm.prank(creator);
        vm.expectRevert(IPerkLaunchFactory.QuoteNotAllowed.selector);
        t.factory.previewLaunch(p);
    }

    function test_previewLaunch_reverts_nonEmptyModuleParams() public {
        PerkTypes.CreateLaunchParams memory p = _base(PerkConstants.TEMPLATE_PERK_GRANT_V1, t.erc20Quote, SALT, 0);
        p.moduleParams = bytes("not-empty");
        vm.prank(creator);
        vm.expectRevert(IPerkTemplateRegistry.ModuleParamsNotSupported.selector);
        t.factory.previewLaunch(p);
    }

    function test_previewLaunch_reverts_incompatibleModule() public {
        t.moduleRegistry.setModuleStatus(PerkConstants.MODULE_ID_LP_GRANT, 1, PerkTypes.RegistryStatus.DEPRECATED);
        PerkTypes.CreateLaunchParams memory p = _base(PerkConstants.TEMPLATE_PERK_GRANT_V1, t.erc20Quote, SALT, 0);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(IPerkLaunchFactory.ModuleIncompatible.selector, "module not active"));
        t.factory.previewLaunch(p);
    }

    // -------------------------------------------------------------------------
    // preview / create hash agreement
    // -------------------------------------------------------------------------

    function test_previewLaunch_agreesWithCreate_predictedMemeAndConfigHash() public {
        (PerkTypes.CreateLaunchParams memory p, address predicted, bytes32 configHash) =
            _ready(creator, PerkConstants.TEMPLATE_PERK_GRANT_V1, t.erc20Quote, SALT, 0);

        vm.prank(creator);
        (address meme, bytes32 launchId) = t.factory.createLaunch(p);

        assertEq(meme, predicted);
        PerkTypes.LaunchRecord memory rec = t.factory.getLaunch(meme);
        assertEq(rec.configHash, configHash);
        assertEq(t.factory.launchByLaunchId(launchId), meme);
    }

    function test_createLaunch_reverts_configHashMismatch() public {
        PerkTypes.CreateLaunchParams memory p = _base(PerkConstants.TEMPLATE_PERK_GRANT_V1, t.erc20Quote, SALT, 0);
        vm.prank(creator);
        (,,, bytes32 actual) = t.factory.previewLaunch(p);
        p.expectedConfigHash = bytes32(uint256(1));
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(IPerkLaunchFactory.ConfigHashMismatch.selector, p.expectedConfigHash, actual)
        );
        t.factory.createLaunch(p);
    }

    // -------------------------------------------------------------------------
    // createLaunch Perk + ERC-20
    // -------------------------------------------------------------------------

    function test_createLaunch_perkErc20_fullTopology() public {
        (PerkTypes.CreateLaunchParams memory p, address predicted, bytes32 configHash) =
            _ready(creator, PerkConstants.TEMPLATE_PERK_GRANT_V1, t.erc20Quote, SALT, 0);
        bytes32 launchId = keccak256(abi.encode(block.chainid, address(t.factory), predicted));
        _expectPerkCreatedEvents(predicted, launchId, configHash);

        uint256 gasBefore = gasleft();
        vm.prank(creator);
        (address meme, bytes32 returnedId) = t.factory.createLaunch(p);
        uint256 gasUsed = gasBefore - gasleft();
        emit log_named_uint("createLaunch (no dev buy) gas", gasUsed);

        assertEq(meme, predicted);
        assertEq(returnedId, launchId);
        assertEq(t.factory.launchCount(), 1);
        _assertPerkBalances(meme);
        _assertExcluded(meme);
        _assertFeeRouterAndCurve(meme);
        _assertLaunchRecord(meme, launchId, configHash);
    }

    function test_createLaunch_standard_noGrantReserve() public {
        PerkTypes.Template memory tmpl = t.templateRegistry.getTemplate(PerkConstants.TEMPLATE_STANDARD_CURVE_V1);
        (PerkTypes.CreateLaunchParams memory p, address predicted,) =
            _ready(creator, PerkConstants.TEMPLATE_STANDARD_CURVE_V1, t.erc20Quote, SALT, 0);

        vm.prank(creator);
        (address meme,) = t.factory.createLaunch(p);

        assertEq(meme, predicted);
        assertEq(IERC20(meme).balanceOf(address(t.vault)), 0);
        assertEq(tmpl.supply.grantReserveSupply, 0);
        PerkTypes.LaunchRecord memory rec = t.factory.getLaunch(meme);
        assertFalse(rec.lpGrantEnabled);
        assertEq(rec.moduleBitmap, PerkConstants.CORE_MODULES_V1);
        assertEq(tmpl.moduleBitmap, PerkConstants.CORE_MODULES_V1);
    }

    // -------------------------------------------------------------------------
    // native quote + dev buy
    // -------------------------------------------------------------------------

    function test_createLaunch_reverts_nativeAmountMismatch() public {
        (PerkTypes.CreateLaunchParams memory p,,) =
            _ready(creator, PerkConstants.TEMPLATE_PERK_GRANT_V1, t.nativeQuote, SALT, DEV_BUY);
        vm.prank(creator);
        vm.expectRevert(IPerkLaunchFactory.NativeAmountMismatch.selector);
        t.factory.createLaunch{value: DEV_BUY - 1}(p);
    }

    function test_createLaunch_nativeDevBuy_happyPath() public {
        (PerkTypes.CreateLaunchParams memory p, address predicted,) =
            _ready(creator, PerkConstants.TEMPLATE_PERK_GRANT_V1, t.nativeQuote, SALT, DEV_BUY);

        vm.recordLogs();
        vm.prank(creator);
        (address meme,) = t.factory.createLaunch{value: DEV_BUY}(p);

        assertEq(meme, predicted);
        assertGt(IERC20(meme).balanceOf(creator), 0);
        assertEq(address(t.factory).balance, 0);
        _assertDevBuyExecuted(meme, creator, DEV_BUY);
        PerkTypes.LaunchRecord memory rec = t.factory.getLaunch(meme);
        assertEq(uint256(rec.status), uint256(PerkTypes.LaunchStatus.CURVE_ACTIVE));
    }

    function test_createLaunch_nativeDevBuy_refundAndGraduationPending() public {
        _registerTinyTemplate();
        uint256 creatorBefore = creator.balance;
        (PerkTypes.CreateLaunchParams memory p,,) = _ready(creator, TINY_TEMPLATE, t.nativeQuote, SALT, DEV_BUY);

        vm.recordLogs();
        vm.prank(creator);
        (address meme,) = t.factory.createLaunch{value: DEV_BUY}(p);

        assertGt(IERC20(meme).balanceOf(creator), 0);
        assertEq(address(t.factory).balance, 0);
        assertGt(creator.balance, creatorBefore - DEV_BUY);
        assertLt(creator.balance, creatorBefore);
        _assertDevBuyExecutedLogged();
        PerkTypes.LaunchRecord memory rec = t.factory.getLaunch(meme);
        assertEq(uint256(rec.status), uint256(PerkTypes.LaunchStatus.GRADUATION_PENDING));
        assertTrue(t.curve.curveState(meme).graduated);
    }

    // -------------------------------------------------------------------------
    // ERC-20 quote + dev buy
    // -------------------------------------------------------------------------

    function test_createLaunch_erc20DevBuy_pullsFromCreator() public {
        uint256 beforeBal = t.quoteToken.balanceOf(creator);
        (PerkTypes.CreateLaunchParams memory p,,) =
            _ready(creator, PerkConstants.TEMPLATE_PERK_GRANT_V1, t.erc20Quote, SALT, DEV_BUY);

        vm.prank(creator);
        (address meme,) = t.factory.createLaunch(p);

        assertEq(t.quoteToken.balanceOf(creator), beforeBal - DEV_BUY);
        assertGt(IERC20(meme).balanceOf(creator), 0);
        assertEq(t.quoteToken.balanceOf(address(t.factory)), 0);
    }

    // -------------------------------------------------------------------------
    // salt
    // -------------------------------------------------------------------------

    function test_createLaunch_reverts_saltReuseSameCreator() public {
        (PerkTypes.CreateLaunchParams memory p,,) =
            _ready(creator, PerkConstants.TEMPLATE_PERK_GRANT_V1, t.erc20Quote, SALT, 0);
        vm.prank(creator);
        t.factory.createLaunch(p);

        vm.prank(creator);
        vm.expectRevert(IPerkLaunchFactory.LaunchExists.selector);
        t.factory.createLaunch(p);
    }

    function test_createLaunch_sameSaltDifferentCreators_differentAddresses() public {
        address creator2 = makeAddr("creator2");
        t.quoteToken.mint(creator2, 1000 ether);
        vm.prank(creator2);
        t.quoteToken.approve(address(t.factory), type(uint256).max);

        (PerkTypes.CreateLaunchParams memory p1, address predicted1,) =
            _ready(creator, PerkConstants.TEMPLATE_PERK_GRANT_V1, t.erc20Quote, SALT, 0);
        (PerkTypes.CreateLaunchParams memory p2, address predicted2,) =
            _ready(creator2, PerkConstants.TEMPLATE_PERK_GRANT_V1, t.erc20Quote, SALT, 0);

        assertTrue(predicted1 != predicted2);

        vm.prank(creator);
        (address meme1,) = t.factory.createLaunch(p1);
        vm.prank(creator2);
        (address meme2,) = t.factory.createLaunch(p2);

        assertEq(meme1, predicted1);
        assertEq(meme2, predicted2);
        assertTrue(meme1 != meme2);
    }

    // -------------------------------------------------------------------------
    // setLaunchStatus
    // -------------------------------------------------------------------------

    function test_setLaunchStatus_reverts_launchNotFound() public {
        vm.expectRevert(IPerkLaunchFactory.LaunchNotFound.selector);
        t.factory.setLaunchStatus(makeAddr("missing"), PerkTypes.LaunchStatus.GRADUATION_PENDING, PoolId.wrap(0));
    }

    function test_setLaunchStatus_reverts_notStatusUpdater() public {
        (address meme,) = _createPerkErc20();
        vm.prank(stranger);
        vm.expectRevert(IPerkLaunchFactory.NotStatusUpdater.selector);
        t.factory.setLaunchStatus(meme, PerkTypes.LaunchStatus.GRADUATION_PENDING, PoolId.wrap(0));
    }

    function test_setLaunchStatus_curve_curveActiveToGraduationPending() public {
        (address meme,) = _createPerkErc20();
        vm.prank(address(t.curve));
        vm.expectEmit(true, false, false, true, address(t.factory));
        emit LaunchStatusUpdated(meme, PerkTypes.LaunchStatus.GRADUATION_PENDING, PoolId.wrap(0));
        t.factory.setLaunchStatus(meme, PerkTypes.LaunchStatus.GRADUATION_PENDING, PoolId.wrap(0));
        assertEq(uint256(t.factory.getLaunch(meme).status), uint256(PerkTypes.LaunchStatus.GRADUATION_PENDING));
    }

    function test_setLaunchStatus_reverts_curveInvalidTransition() public {
        (address meme,) = _createPerkErc20();
        vm.prank(address(t.curve));
        vm.expectRevert(IPerkLaunchFactory.InvalidStatusTransition.selector);
        t.factory.setLaunchStatus(meme, PerkTypes.LaunchStatus.GRADUATED, PoolId.wrap(0));
    }

    function test_setLaunchStatus_graduationManager_storesPoolId() public {
        (address meme,) = _createPerkErc20();
        vm.prank(address(t.curve));
        t.factory.setLaunchStatus(meme, PerkTypes.LaunchStatus.GRADUATION_PENDING, PoolId.wrap(0));

        PoolId poolId = PoolId.wrap(bytes32(uint256(123)));
        vm.prank(t.graduationManager);
        t.factory.setLaunchStatus(meme, PerkTypes.LaunchStatus.GRADUATED, poolId);

        PerkTypes.LaunchRecord memory rec = t.factory.getLaunch(meme);
        assertEq(uint256(rec.status), uint256(PerkTypes.LaunchStatus.GRADUATED));
        assertEq(PoolId.unwrap(rec.poolId), PoolId.unwrap(poolId));
    }

    function test_setLaunchStatus_reverts_graduationManagerInvalidTransition() public {
        (address meme,) = _createPerkErc20();
        vm.prank(t.graduationManager);
        vm.expectRevert(IPerkLaunchFactory.InvalidStatusTransition.selector);
        t.factory.setLaunchStatus(meme, PerkTypes.LaunchStatus.GRADUATED, PoolId.wrap(0));
    }

    // -------------------------------------------------------------------------
    function test_wire_reverts_alreadyWired() public {
        vm.expectRevert(LaunchFactory.AlreadyWired.selector);
        t.factory
            .wire(
                address(t.curve),
                address(t.feeRouter),
                address(t.distributor),
                address(t.hook),
                t.graduationManager,
                address(t.vault)
            );
    }

    // -------------------------------------------------------------------------
    // helpers
    // -------------------------------------------------------------------------

    function _base(bytes32 templateId, Currency quote, bytes32 salt, uint256 devBuy)
        internal
        pure
        returns (PerkTypes.CreateLaunchParams memory p)
    {
        p.templateId = templateId;
        p.quote = quote;
        p.moduleParams = "";
        p.metadata = PerkTypes.TokenMetadata({name: "Frog", symbol: "FROG", uri: "ipfs://frog"});
        p.devBuyQuote = devBuy;
        p.salt = salt;
    }

    function _ready(address who, bytes32 templateId, Currency quote, bytes32 salt, uint256 devBuy)
        internal
        returns (PerkTypes.CreateLaunchParams memory p, address predictedMeme, bytes32 configHash)
    {
        p = _base(templateId, quote, salt, devBuy);
        vm.prank(who);
        (predictedMeme,,, configHash) = t.factory.previewLaunch(p);
        p.expectedConfigHash = configHash;
    }

    function _createPerkErc20() internal returns (address meme, bytes32 launchId) {
        (PerkTypes.CreateLaunchParams memory p,,) =
            _ready(creator, PerkConstants.TEMPLATE_PERK_GRANT_V1, t.erc20Quote, keccak256("status-salt"), 0);
        vm.prank(creator);
        return t.factory.createLaunch(p);
    }

    function _expectPerkCreatedEvents(address predicted, bytes32 launchId, bytes32 configHash) internal {
        PerkTypes.Template memory tmpl = t.templateRegistry.getTemplate(PerkConstants.TEMPLATE_PERK_GRANT_V1);
        bytes32 paramsHash = keccak256("");
        vm.expectEmit(true, true, true, true, address(t.factory));
        emit LaunchCreated(launchId, predicted, creator, t.erc20Quote, PerkConstants.TEMPLATE_PERK_GRANT_V1, configHash);
        vm.expectEmit(true, true, false, true, address(t.factory));
        emit LaunchTemplateSelected(
            launchId, PerkConstants.TEMPLATE_PERK_GRANT_V1, tmpl.hookVersion, tmpl.moduleBitmap, paramsHash
        );
        vm.expectEmit(true, true, false, true, address(t.factory));
        emit HookModulesCommitted(launchId, address(t.hook), tmpl.moduleBitmap, configHash);
        vm.expectEmit(true, false, false, true, address(t.factory));
        emit LaunchStatusUpdated(predicted, PerkTypes.LaunchStatus.CURVE_ACTIVE, PoolId.wrap(bytes32(0)));
    }

    function _assertPerkBalances(address meme) internal view {
        PerkTypes.Template memory tmpl = t.templateRegistry.getTemplate(PerkConstants.TEMPLATE_PERK_GRANT_V1);
        PerkMemeToken token = PerkMemeToken(meme);
        assertEq(token.totalSupply(), tmpl.supply.totalSupply);
        assertEq(token.balanceOf(address(t.curve)), tmpl.supply.curveSupply + tmpl.supply.poolReserveSupply);
        assertEq(token.balanceOf(address(t.vault)), tmpl.supply.grantReserveSupply);
        assertEq(tmpl.supply.grantReserveSupply, tmpl.supply.totalSupply * 1500 / 10_000);
        assertEq(token.balanceOf(address(t.factory)), 0);
    }

    function _assertFeeRouterAndCurve(address meme) internal view {
        PerkTypes.Template memory tmpl = t.templateRegistry.getTemplate(PerkConstants.TEMPLATE_PERK_GRANT_V1);
        IPerkFeeRouter.LaunchFees memory fees = t.feeRouter.launchFees(meme);
        assertTrue(fees.registered);
        assertEq(Currency.unwrap(fees.quote), Currency.unwrap(t.erc20Quote));
        assertEq(fees.dev, creator);
        assertEq(fees.curve, address(t.curve));
        assertEq(fees.totalFeeBps, tmpl.totalFeeBps);

        IPerkBondingCurve.CurveState memory st = t.curve.curveState(meme);
        assertTrue(st.initialized);
        assertFalse(st.graduated);
        IPerkBondingCurve.CurveConfig memory cfg = t.curve.curveConfig(meme);
        assertEq(Currency.unwrap(cfg.quote), Currency.unwrap(t.erc20Quote));
        assertEq(cfg.curveSupply, tmpl.supply.curveSupply);
        assertEq(cfg.poolReserveSupply, tmpl.supply.poolReserveSupply);
        assertEq(cfg.virtualQuoteReserve, tmpl.curve.virtualQuoteReserve);
        assertEq(cfg.virtualMemeReserve, tmpl.curve.virtualMemeReserve);
        assertEq(cfg.graduationQuoteThreshold, tmpl.curve.graduationQuoteThreshold);
        assertEq(cfg.totalFeeBps, tmpl.totalFeeBps);
    }

    function _assertLaunchRecord(address meme, bytes32 launchId, bytes32 configHash) internal view {
        PerkTypes.Template memory tmpl = t.templateRegistry.getTemplate(PerkConstants.TEMPLATE_PERK_GRANT_V1);
        PerkTypes.LaunchRecord memory rec = t.factory.getLaunch(meme);
        assertEq(rec.launchId, launchId);
        assertEq(rec.creator, creator);
        assertEq(rec.meme, meme);
        assertEq(Currency.unwrap(rec.quote), Currency.unwrap(t.erc20Quote));
        assertEq(rec.templateId, PerkConstants.TEMPLATE_PERK_GRANT_V1);
        assertEq(rec.hookVersion, tmpl.hookVersion);
        assertEq(rec.moduleBitmap, tmpl.moduleBitmap);
        assertEq(rec.moduleParamsHash, keccak256(""));
        assertEq(rec.configHash, configHash);
        assertEq(rec.hook, address(t.hook));
        assertTrue(rec.lpGrantEnabled);
        assertEq(uint256(rec.status), uint256(PerkTypes.LaunchStatus.CURVE_ACTIVE));
        assertEq(rec.createdAt, uint64(block.timestamp));
        assertEq(PoolId.unwrap(rec.poolId), bytes32(0));
    }

    function _assertExcluded(address meme) internal view {
        assertTrue(t.distributor.isExcluded(meme, t.poolManager));
        assertTrue(t.distributor.isExcluded(meme, address(t.curve)));
        assertTrue(t.distributor.isExcluded(meme, address(t.factory)));
        assertTrue(t.distributor.isExcluded(meme, address(t.vault)));
        assertTrue(t.distributor.isExcluded(meme, address(t.feeRouter)));
        assertTrue(t.distributor.isExcluded(meme, address(t.treasury)));
        assertTrue(t.distributor.isExcluded(meme, address(t.distributor)));
        assertTrue(t.distributor.isExcluded(meme, address(t.hook)));
        assertTrue(t.distributor.isExcluded(meme, t.graduationManager));
    }

    function _assertDevBuyExecuted(address meme, address who, uint256 quoteIn) internal view {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = keccak256("DevBuyExecuted(address,address,uint256,uint256)");
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(t.factory) || logs[i].topics[0] != topic) continue;
            found = true;
            assertEq(address(uint160(uint256(logs[i].topics[1]))), meme);
            assertEq(address(uint160(uint256(logs[i].topics[2]))), who);
            (uint256 loggedQuoteIn, uint256 memeOut) = abi.decode(logs[i].data, (uint256, uint256));
            assertEq(loggedQuoteIn, quoteIn);
            assertGt(memeOut, 0);
        }
        assertTrue(found);
    }

    function _assertDevBuyExecutedLogged() internal view {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = keccak256("DevBuyExecuted(address,address,uint256,uint256)");
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(t.factory) && logs[i].topics[0] == topic) {
                found = true;
                (, uint256 memeOut) = abi.decode(logs[i].data, (uint256, uint256));
                assertGt(memeOut, 0);
            }
        }
        assertTrue(found);
    }

    function _registerTinyTemplate() internal {
        PerkTypes.Template memory tmpl = PerkTemplates.perkGrantV1(PerkTemplates.defaultNumbers());
        tmpl.curve.graduationQuoteThreshold = 1;
        t.templateRegistry.registerTemplate(TINY_TEMPLATE, tmpl);
    }
}
