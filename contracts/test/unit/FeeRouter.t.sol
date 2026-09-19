// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {FeeRouter} from "../../src/fees/FeeRouter.sol";
import {CommunityTreasury} from "../../src/treasury/CommunityTreasury.sol";
import {IPerkFeeRouter} from "../../src/interfaces/IPerkFeeRouter.sol";
import {PerkTypes} from "../../src/libraries/PerkTypes.sol";
import {MockDistributor} from "../utils/MockDistributor.sol";
import {MockERC20} from "../utils/MockERC20.sol";

contract FeeRouterTest is Test {
    uint24 internal constant TOTAL_FEE_BPS = 100;

    FeeRouter internal router;
    MockDistributor internal distributor;
    CommunityTreasury internal treasury;
    MockERC20 internal quoteToken;

    address internal hook;
    address internal graduationManager;
    address internal protocolFeeRecipient;
    address internal dev;
    address internal newDev;
    address internal curve;
    address internal meme;
    address internal memeErc20;
    address internal stranger;

    Currency internal native;
    Currency internal erc20;

    PerkTypes.FeeSplit internal split;

    event LaunchRegistered(address indexed meme, Currency indexed quote, address dev, address curve);
    event FeesRouted(
        address indexed meme,
        PerkTypes.FeeSource source,
        uint256 amount,
        uint256 devShare,
        uint256 rewardsShare,
        uint256 lpShare,
        uint256 treasuryShare,
        uint256 protocolShare
    );
    event DevFeesClaimed(address indexed meme, address indexed dev, uint256 amount);
    event DevRecipientUpdated(address indexed meme, address indexed oldDev, address indexed newDev);
    event TreasuryFeesPushed(address indexed meme, uint256 amount);
    event ProtocolFeesClaimed(Currency indexed quote, address indexed to, uint256 amount);
    event LpReserveReleased(address indexed meme, address indexed to, uint256 amount);
    event Received(Currency indexed quote, address indexed from, uint256 amount, bytes32 indexed ref);

    function setUp() public {
        hook = makeAddr("hook");
        graduationManager = makeAddr("graduationManager");
        protocolFeeRecipient = makeAddr("protocolFeeRecipient");
        dev = makeAddr("dev");
        newDev = makeAddr("newDev");
        curve = makeAddr("curve");
        meme = makeAddr("meme");
        memeErc20 = makeAddr("memeErc20");
        stranger = makeAddr("stranger");
        native = Currency.wrap(address(0));

        distributor = new MockDistributor();
        treasury = new CommunityTreasury(address(this), 1 days);
        quoteToken = new MockERC20("Quote", "Q", 6);
        erc20 = Currency.wrap(address(quoteToken));

        router =
            new FeeRouter(address(this), address(this), address(distributor), address(treasury), protocolFeeRecipient);
        router.wire(hook, graduationManager);

        split = PerkTypes.FeeSplit({devBps: 5000, rewardsBps: 2500, lpBps: 1500, treasuryBps: 500, protocolBps: 500});

        router.registerLaunch(meme, native, dev, curve, TOTAL_FEE_BPS, split);
        router.registerLaunch(memeErc20, erc20, dev, curve, TOTAL_FEE_BPS, split);
    }

    function test_registerLaunch_reverts_onlyFactory() public {
        vm.prank(stranger);
        vm.expectRevert(IPerkFeeRouter.NotFactory.selector);
        router.registerLaunch(makeAddr("other"), native, dev, curve, TOTAL_FEE_BPS, split);
    }

    function test_registerLaunch_reverts_invalidSplit() public {
        PerkTypes.FeeSplit memory bad = split;
        bad.protocolBps = 499;
        vm.expectRevert(FeeRouter.InvalidSplit.selector);
        router.registerLaunch(makeAddr("other"), native, dev, curve, TOTAL_FEE_BPS, bad);
    }

    function test_registerLaunch_reverts_alreadyRegistered() public {
        vm.expectRevert(IPerkFeeRouter.AlreadyRegistered.selector);
        router.registerLaunch(meme, native, dev, curve, TOTAL_FEE_BPS, split);
    }

    function test_registerLaunch_erc20_setsDistributorApproval() public view {
        assertEq(quoteToken.allowance(address(router), address(distributor)), type(uint256).max);
    }

    function test_registerLaunch_emitsLaunchRegistered() public {
        address fresh = makeAddr("fresh");
        vm.expectEmit(true, true, false, true, address(router));
        emit LaunchRegistered(fresh, native, dev, curve);
        router.registerLaunch(fresh, native, dev, curve, TOTAL_FEE_BPS, split);
    }

    function test_collectFee_curve_native_reverts_valueMismatch() public {
        vm.deal(curve, 10_000);
        vm.prank(curve);
        vm.expectRevert(IPerkFeeRouter.NativeAmountMismatch.selector);
        router.collectFee{value: 9999}(meme, PerkTypes.FeeSource.CURVE, 10_000);
    }

    function test_collectFee_curve_native_splitAndLpReserve() public {
        uint256 amount = 10_000;
        vm.deal(curve, amount);
        vm.expectEmit(true, false, false, true, address(router));
        emit FeesRouted(meme, PerkTypes.FeeSource.CURVE, amount, 5000, 2500, 1500, 500, 500);
        vm.prank(curve);
        router.collectFee{value: amount}(meme, PerkTypes.FeeSource.CURVE, amount);

        IPerkFeeRouter.LaunchFees memory fees = router.launchFees(meme);
        assertEq(fees.devClaimable, 5000);
        assertEq(fees.lpReserve, 1500);
        assertEq(fees.treasuryPending, 500);
        assertEq(router.protocolClaimable(native), 500);

        assertEq(distributor.callCount(), 1);
        assertEq(distributor.lastAccrueAmount(), 2500);
        (address recordedMeme, uint256 recordedAmount, uint256 recordedValue) = distributor.calls(0);
        assertEq(recordedMeme, meme);
        assertEq(recordedAmount, 2500);
        assertEq(recordedValue, 2500);
        assertEq(address(distributor).balance, 2500);
    }

    function test_collectFee_hook_native_reverts_nonzeroValue() public {
        vm.deal(hook, 1);
        vm.prank(hook);
        vm.expectRevert(IPerkFeeRouter.NativeAmountMismatch.selector);
        router.collectFee{value: 1}(meme, PerkTypes.FeeSource.HOOK, 8500);
    }

    function test_collectFee_hook_native_splitUsesDenominator() public {
        uint256 amount = 8500;
        vm.deal(address(router), amount);
        vm.expectEmit(true, false, false, true, address(router));
        emit FeesRouted(meme, PerkTypes.FeeSource.HOOK, amount, 5000, 2500, 0, 500, 500);
        vm.prank(hook);
        router.collectFee(meme, PerkTypes.FeeSource.HOOK, amount);

        IPerkFeeRouter.LaunchFees memory fees = router.launchFees(meme);
        assertEq(fees.devClaimable, 5000);
        assertEq(fees.lpReserve, 0);
        assertEq(fees.treasuryPending, 500);
        assertEq(router.protocolClaimable(native), 500);
        assertEq(distributor.lastAccrueAmount(), 2500);
        assertEq(address(distributor).balance, 2500);
    }

    function test_collectFee_erc20_curve_distributorPullsRewards() public {
        uint256 amount = 10_000;
        quoteToken.mint(address(router), amount);
        distributor.setQuoteToken(quoteToken);
        vm.prank(curve);
        router.collectFee(memeErc20, PerkTypes.FeeSource.CURVE, amount);

        IPerkFeeRouter.LaunchFees memory fees = router.launchFees(memeErc20);
        assertEq(fees.devClaimable, 5000);
        assertEq(fees.lpReserve, 1500);
        assertEq(fees.treasuryPending, 500);
        assertEq(router.protocolClaimable(erc20), 500);
        assertEq(quoteToken.balanceOf(address(distributor)), 2500);
        assertEq(distributor.lastAccrueAmount(), 2500);
        assertEq(quoteToken.balanceOf(address(router)), 7500);
    }

    function test_collectFee_erc20_hook_distributorPullsRewards() public {
        uint256 amount = 8500;
        quoteToken.mint(address(router), amount);
        distributor.setQuoteToken(quoteToken);
        vm.prank(hook);
        router.collectFee(memeErc20, PerkTypes.FeeSource.HOOK, amount);

        IPerkFeeRouter.LaunchFees memory fees = router.launchFees(memeErc20);
        assertEq(fees.devClaimable, 5000);
        assertEq(fees.lpReserve, 0);
        assertEq(fees.treasuryPending, 500);
        assertEq(router.protocolClaimable(erc20), 500);
        assertEq(quoteToken.balanceOf(address(distributor)), 2500);
        assertEq(quoteToken.balanceOf(address(router)), 6000);
    }

    function test_collectFee_reverts_notAuthorizedSource_curve() public {
        vm.prank(stranger);
        vm.expectRevert(IPerkFeeRouter.NotAuthorizedSource.selector);
        router.collectFee(meme, PerkTypes.FeeSource.CURVE, 1);
    }

    function test_collectFee_reverts_notAuthorizedSource_hook() public {
        vm.prank(stranger);
        vm.expectRevert(IPerkFeeRouter.NotAuthorizedSource.selector);
        router.collectFee(meme, PerkTypes.FeeSource.HOOK, 1);
    }

    function test_collectFee_reverts_notRegistered() public {
        vm.prank(curve);
        vm.expectRevert(IPerkFeeRouter.NotRegistered.selector);
        router.collectFee(makeAddr("unknown"), PerkTypes.FeeSource.CURVE, 1);
    }

    function testFuzz_collectFee_curve_sharesSumToAmount(uint256 amount) public {
        amount = bound(amount, 1, 1e30);
        vm.deal(curve, amount);
        vm.prank(curve);
        router.collectFee{value: amount}(meme, PerkTypes.FeeSource.CURVE, amount);

        IPerkFeeRouter.LaunchFees memory fees = router.launchFees(meme);
        uint256 rewards = distributor.callCount() == 0 ? 0 : distributor.lastAccrueAmount();
        assertEq(
            fees.devClaimable + rewards + fees.lpReserve + fees.treasuryPending + router.protocolClaimable(native),
            amount
        );
    }

    function testFuzz_collectFee_hook_sharesSumToAmount(uint256 amount) public {
        amount = bound(amount, 1, 1e30);
        vm.deal(address(router), amount);
        vm.prank(hook);
        router.collectFee(meme, PerkTypes.FeeSource.HOOK, amount);

        IPerkFeeRouter.LaunchFees memory fees = router.launchFees(meme);
        uint256 rewards = distributor.callCount() == 0 ? 0 : distributor.lastAccrueAmount();
        assertEq(
            fees.devClaimable + rewards + fees.lpReserve + fees.treasuryPending + router.protocolClaimable(native),
            amount
        );
        assertEq(fees.lpReserve, 0);
    }

    function test_collectFee_rewardsZero_doesNotCallDistributor() public {
        vm.deal(curve, 1);
        vm.prank(curve);
        router.collectFee{value: 1}(meme, PerkTypes.FeeSource.CURVE, 1);
        assertEq(distributor.callCount(), 0);
        IPerkFeeRouter.LaunchFees memory fees = router.launchFees(meme);
        assertEq(fees.devClaimable + fees.lpReserve + fees.treasuryPending + router.protocolClaimable(native), 1);
    }

    function test_claimDevFees_paysDevAndZeroes() public {
        vm.deal(curve, 10_000);
        vm.prank(curve);
        router.collectFee{value: 10_000}(meme, PerkTypes.FeeSource.CURVE, 10_000);

        uint256 before = dev.balance;
        vm.expectEmit(true, true, false, true, address(router));
        emit DevFeesClaimed(meme, dev, 5000);
        vm.prank(stranger);
        (Currency quote, uint256 paid) = router.claimDevFees(meme);
        assertEq(Currency.unwrap(quote), address(0));
        assertEq(paid, 5000);
        assertEq(dev.balance, before + 5000);
        assertEq(router.launchFees(meme).devClaimable, 0);

        (, uint256 second) = router.claimDevFees(meme);
        assertEq(second, 0);
    }

    function test_setDevRecipient_onlyCurrentDev_affectsSubsequentClaims() public {
        vm.deal(curve, 20_000);
        vm.prank(curve);
        router.collectFee{value: 10_000}(meme, PerkTypes.FeeSource.CURVE, 10_000);

        vm.prank(stranger);
        vm.expectRevert(IPerkFeeRouter.NotDev.selector);
        router.setDevRecipient(meme, newDev);

        vm.prank(dev);
        vm.expectRevert(IPerkFeeRouter.ZeroAddress.selector);
        router.setDevRecipient(meme, address(0));

        vm.prank(dev);
        vm.expectEmit(true, true, true, true, address(router));
        emit DevRecipientUpdated(meme, dev, newDev);
        router.setDevRecipient(meme, newDev);

        vm.prank(stranger);
        (Currency quote, uint256 paid) = router.claimDevFees(meme);
        assertEq(Currency.unwrap(quote), address(0));
        assertEq(paid, 5000);
        assertEq(newDev.balance, 5000);
        assertEq(dev.balance, 0);

        vm.prank(curve);
        router.collectFee{value: 10_000}(meme, PerkTypes.FeeSource.CURVE, 10_000);
        router.claimDevFees(meme);
        assertEq(newDev.balance, 10_000);
        assertEq(dev.balance, 0);
    }

    function test_pushTreasuryFees_native_depositsWithLaunchRef() public {
        vm.deal(curve, 10_000);
        vm.prank(curve);
        router.collectFee{value: 10_000}(meme, PerkTypes.FeeSource.CURVE, 10_000);

        bytes32 launchRef = keccak256(abi.encode(block.chainid, address(this), meme));
        vm.expectEmit(true, false, false, true, address(router));
        emit TreasuryFeesPushed(meme, 500);
        vm.expectEmit(true, true, true, true, address(treasury));
        emit Received(native, address(router), 500, launchRef);
        vm.prank(stranger);
        uint256 pushed = router.pushTreasuryFees(meme);

        assertEq(pushed, 500);
        assertEq(router.launchFees(meme).treasuryPending, 0);
        assertEq(treasury.balance(native), 500);
    }

    function test_pushTreasuryFees_erc20_depositsWithLaunchRef() public {
        quoteToken.mint(address(router), 10_000);
        distributor.setQuoteToken(quoteToken);
        vm.prank(curve);
        router.collectFee(memeErc20, PerkTypes.FeeSource.CURVE, 10_000);

        bytes32 launchRef = keccak256(abi.encode(block.chainid, address(this), memeErc20));
        vm.expectEmit(true, false, false, true, address(router));
        emit TreasuryFeesPushed(memeErc20, 500);
        vm.expectEmit(true, true, true, true, address(treasury));
        emit Received(erc20, address(router), 500, launchRef);
        uint256 pushed = router.pushTreasuryFees(memeErc20);

        assertEq(pushed, 500);
        assertEq(router.launchFees(memeErc20).treasuryPending, 0);
        assertEq(treasury.balance(erc20), 500);
        assertEq(quoteToken.balanceOf(address(treasury)), 500);
    }

    function test_claimProtocolFees_perQuote() public {
        vm.deal(curve, 10_000);
        vm.prank(curve);
        router.collectFee{value: 10_000}(meme, PerkTypes.FeeSource.CURVE, 10_000);

        quoteToken.mint(address(router), 10_000);
        distributor.setQuoteToken(quoteToken);
        vm.prank(curve);
        router.collectFee(memeErc20, PerkTypes.FeeSource.CURVE, 10_000);

        vm.expectEmit(true, true, false, true, address(router));
        emit ProtocolFeesClaimed(native, protocolFeeRecipient, 500);
        vm.prank(stranger);
        uint256 nativePaid = router.claimProtocolFees(native);
        assertEq(nativePaid, 500);
        assertEq(protocolFeeRecipient.balance, 500);
        assertEq(router.protocolClaimable(native), 0);
        assertEq(router.protocolClaimable(erc20), 500);

        uint256 erc20Paid = router.claimProtocolFees(erc20);
        assertEq(erc20Paid, 500);
        assertEq(quoteToken.balanceOf(protocolFeeRecipient), 500);
        assertEq(router.protocolClaimable(erc20), 0);
    }

    function test_releaseLpReserve_onlyGraduationManager() public {
        vm.deal(curve, 10_000);
        vm.prank(curve);
        router.collectFee{value: 10_000}(meme, PerkTypes.FeeSource.CURVE, 10_000);

        address to = makeAddr("lpSink");
        vm.prank(stranger);
        vm.expectRevert(IPerkFeeRouter.NotGraduationManager.selector);
        router.releaseLpReserve(meme, to);

        vm.expectEmit(true, true, false, true, address(router));
        emit LpReserveReleased(meme, to, 1500);
        vm.prank(graduationManager);
        uint256 released = router.releaseLpReserve(meme, to);
        assertEq(released, 1500);
        assertEq(to.balance, 1500);
        assertEq(router.launchFees(meme).lpReserve, 0);
    }

    function test_wire_onceOnly() public {
        vm.expectRevert(FeeRouter.AlreadyWired.selector);
        router.wire(hook, graduationManager);
    }

    function test_wire_reverts_notOwner() public {
        FeeRouter unwired =
            new FeeRouter(address(this), address(this), address(distributor), address(treasury), protocolFeeRecipient);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        unwired.wire(hook, graduationManager);
    }

    function test_gas_collectFee_nativeCurve() public {
        vm.deal(curve, 20_000);
        vm.prank(curve);
        router.collectFee{value: 10_000}(meme, PerkTypes.FeeSource.CURVE, 10_000);

        uint256 gasBefore = gasleft();
        vm.prank(curve);
        router.collectFee{value: 10_000}(meme, PerkTypes.FeeSource.CURVE, 10_000);
        uint256 gasUsed = gasBefore - gasleft();
        emit log_named_uint("gas_collectFee_native_CURVE", gasUsed);
    }

    function test_gas_collectFee_nativeHook() public {
        vm.deal(address(router), 17_000);
        vm.prank(hook);
        router.collectFee(meme, PerkTypes.FeeSource.HOOK, 8500);

        uint256 gasBefore = gasleft();
        vm.prank(hook);
        router.collectFee(meme, PerkTypes.FeeSource.HOOK, 8500);
        uint256 gasUsed = gasBefore - gasleft();
        emit log_named_uint("gas_collectFee_native_HOOK", gasUsed);
    }
}
