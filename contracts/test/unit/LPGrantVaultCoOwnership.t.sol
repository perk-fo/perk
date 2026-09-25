// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

// forge-lint: disable-start(environment-read-across-mutation)

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {Currency, CurrencyLibrary} from "v4-core/src/types/Currency.sol";
import {Vm} from "forge-std/Vm.sol";

import {IPerkLPGrantVault} from "../../src/interfaces/IPerkLPGrantVault.sol";
import {PerkConstants} from "../../src/libraries/PerkConstants.sol";
import {PerkTypes} from "../../src/libraries/PerkTypes.sol";
import {PerkTemplates} from "../../script/lib/PerkTemplates.sol";
import {MockERC20} from "../utils/MockERC20.sol";
import {GrantTestBase} from "../utils/GrantTestBase.sol";
import {MerkleTree} from "../utils/MerkleTree.sol";

/// @dev PRD 6 v0.14: grant positions co-owned pro rata by the beneficiary and the protocol, settled at the hook's
///      reference price; one shared first-come-first-served inventory; boosts and credits earned on base activation.
contract LPGrantVaultCoOwnershipTest is GrantTestBase {
    using PoolIdLibrary for PoolKey;

    event InviteeBoostEarned(address indexed meme, address indexed account, uint256 amount);
    event InviterCreditEarned(address indexed meme, address indexed inviter, address indexed invitee, uint256 amount);
    event ReferralCreditCapped(address indexed meme, address indexed inviter, uint256 requested, uint256 granted);

    struct Exit {
        uint256 toUser;
        uint256 memeToUser;
        uint256 toTreasury;
        uint256 burned;
    }

    function setUp() public {
        _setUpPerk();
        _bindBobToAlice();
    }

    // -------------------------------------------------------------------------
    // Settlement
    // -------------------------------------------------------------------------

    /// @dev The PRD's worked check. Full range, g = 0.5, fees collected beforehand, reference = spot: for an exit
    ///      price r times the entry price the beneficiary receives D*sqrt(r), all of it in quote (the quote leg
    ///      itself is D*sqrt(r)); the treasury receives whatever quote is left, the rest of the meme is burned and
    ///      nothing of the position stays in the vault.
    function test_exitGrantPosition_settlementTable_fullRange() public {
        (address meme, uint256 pos) = _open(keccak256("table"));
        IPerkLPGrantVault.GrantPosition memory p = t.vault.position(pos);
        uint256[5] memory sqrtR = [uint256(0.5e18), 707_106_781_186_547_524, 1e18, 1_414_213_562_373_095_048, 2e18];

        for (uint256 i; i < sqrtR.length; ++i) {
            uint256 snap = vm.snapshotState();
            _moveTo(meme, _targetSqrt(meme, p.entrySqrtPriceX96, sqrtR[i]));
            vm.warp(vm.getBlockTimestamp() + 1 days + 1); // min LP time, and the reference catches up with the pool
            (int24 spotTick, int24 refTick) = t.hook.referencePrice(_poolId(meme));
            assertEq(spotTick, refTick, "reference = spot");
            t.vault.collectGrantFees(pos); // no fees in the settlement

            uint256 realSqrtR = _realSqrtR(meme, p.entrySqrtPriceX96, _sqrtPriceOf(meme));
            assertApproxEqRel(realSqrtR, sqrtR[i], 1e12);
            uint256 expected = Math.mulDiv(p.quoteDeposited, realSqrtR, 1e18);

            uint256 vaultMemeBefore = IERC20(meme).balanceOf(address(t.vault));
            uint256 treasuryBefore = t.quoteToken.balanceOf(address(t.treasury));
            uint256 supplyBefore = IERC20(meme).totalSupply();
            Exit memory e = _exit(pos);

            uint256 userValue = e.toUser + _memeValueInQuoteAt(meme, e.memeToUser, TickMath.getSqrtPriceAtTick(refTick));
            emit log_named_uint("sqrt(r) wad", sqrtR[i]);
            emit log_named_uint("  D * sqrt(r)", expected);
            emit log_named_uint("  quote to user", e.toUser);
            emit log_named_uint("  meme to user", e.memeToUser);
            emit log_named_uint("  quote to treasury", e.toTreasury);
            emit log_named_uint("  meme burned", e.burned);
            assertApproxEqRel(userValue, expected, 1e14, "user value = D * sqrt(r)");
            assertApproxEqRel(e.toUser, expected, 1e14, "paid in quote");
            assertLe(_memeValueInQuote(meme, e.memeToUser), expected / 5000, "no meme beyond rounding");
            if (e.memeToUser > 0) assertEq(e.toTreasury, 0, "quote is paid first");
            assertLe(e.toTreasury, expected / 5000, "the protocol's quote share is the rounding");
            assertApproxEqRel(e.burned + e.memeToUser, Math.mulDiv(p.grantMemeAmount, 1e18, realSqrtR), 1e12);
            assertEq(t.quoteToken.balanceOf(address(t.treasury)) - treasuryBefore, e.toTreasury);
            assertEq(supplyBefore - IERC20(meme).totalSupply(), e.burned);
            assertEq(IERC20(meme).balanceOf(address(t.vault)), vaultMemeBefore, "no meme of the position is left");
            assertEq(t.quoteToken.balanceOf(address(t.vault)), 0, "no quote is left");
            vm.revertToState(snap);
        }
    }

    /// @dev g is the grant meme's share of the position's value at activation: about half for a full-range position.
    ///      It is stored and emitted at activation and no later price move changes it.
    function test_activateGrant_protocolShareFrozenAtActivation() public {
        address meme = _activeDefault(keccak256("g-frozen"));
        _registerDefault(meme);
        _arm(meme);
        (, int24 refTick) = t.hook.referencePrice(_poolId(meme));
        vm.recordLogs();
        uint256 pos = _activate(meme, alice, ALICE_BASE, 0, 0);
        IPerkLPGrantVault.GrantPosition memory p = t.vault.position(pos);
        assertApproxEqRel(p.protocolShareWad, 0.5e18, 1e15);
        assertEq(p.protocolShareWad, _expectedShare(meme, p, p.entrySqrtPriceX96, refTick));

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != IPerkLPGrantVault.GrantActivated.selector) continue;
            (,,, uint256 quoteDeposited, uint128 liquidity, uint64 g) =
                abi.decode(logs[i].data, (uint256, uint256, uint256, uint256, uint128, uint64));
            assertEq(g, p.protocolShareWad);
            assertEq(quoteDeposited, p.quoteDeposited);
            assertEq(liquidity, p.liquidity);
            seen = true;
        }
        assertTrue(seen, "GrantActivated carries g");

        _moveTo(meme, _targetSqrt(meme, p.entrySqrtPriceX96, 2e18));
        vm.warp(vm.getBlockTimestamp() + 1 days);
        assertEq(t.vault.position(pos).protocolShareWad, p.protocolShareWad);
        _moveTo(meme, _targetSqrt(meme, p.entrySqrtPriceX96, 0.5e18));
        vm.warp(vm.getBlockTimestamp() + 1 days);
        assertEq(t.vault.position(pos).protocolShareWad, p.protocolShareWad);
    }

    /// @dev Trading fees go to the beneficiary in full, both currencies, and do not touch the principal settlement:
    ///      collecting them leaves exitPreview unchanged, and an exit pays uncollected fees on top of its settlement.
    function test_fees_allToBeneficiary_bothCurrencies_separateFromPrincipal() public {
        (address meme, uint256 pos) = _open(keccak256("fees"));
        PoolKey memory key = t.graduation.graduationOf(meme).key;
        bool q0 = _quoteIs0(meme);
        _swap(key, q0, 20 ether, 0);
        _sellMeme(key, q0, meme, 2_000_000 ether);
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);

        Exit memory before = _preview(pos);
        uint256 aliceQuote = t.quoteToken.balanceOf(alice);
        uint256 aliceMeme = IERC20(meme).balanceOf(alice);
        vm.prank(stranger); // anyone may trigger it; the beneficiary is paid
        (uint256 qf, uint256 mf) = t.vault.collectGrantFees(pos);
        assertGt(qf, 0);
        assertGt(mf, 0);
        assertEq(t.quoteToken.balanceOf(alice) - aliceQuote, qf);
        assertEq(IERC20(meme).balanceOf(alice) - aliceMeme, mf);
        Exit memory afterCollect = _preview(pos);
        assertEq(afterCollect.toUser, before.toUser);
        assertEq(afterCollect.memeToUser, before.memeToUser);
        assertEq(afterCollect.toTreasury, before.toTreasury);
        assertEq(afterCollect.burned, before.burned);

        // more trading, then exit without collecting first: the fees come on top of the settlement
        _swap(key, q0, 10 ether, 0);
        _sellMeme(key, q0, meme, 1_000_000 ether);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        aliceQuote = t.quoteToken.balanceOf(alice);
        aliceMeme = IERC20(meme).balanceOf(alice);
        Exit memory e = _exit(pos);
        assertGt(t.quoteToken.balanceOf(alice) - aliceQuote, e.toUser, "quote fees on top");
        assertGt(IERC20(meme).balanceOf(alice) - aliceMeme, e.memeToUser, "meme fees on top");
        assertEq(t.quoteToken.balanceOf(address(t.vault)), 0);
    }

    /// @dev exitPreview is what exitGrantPosition pays in the same block, including with the pool pushed far off the
    ///      reference in that block, and all zeros once the position has exited.
    function test_exitPreview_equalsExit_sameBlock() public {
        (address meme, uint256 pos) = _open(keccak256("preview"));
        IPerkLPGrantVault.GrantPosition memory p = t.vault.position(pos);
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        uint256[4] memory sqrtR = [uint256(1e18), 3e18, 0.4e18, 1.1e18];
        for (uint256 i; i < sqrtR.length; ++i) {
            uint256 snap = vm.snapshotState();
            _moveTo(meme, _targetSqrt(meme, p.entrySqrtPriceX96, sqrtR[i]));
            Exit memory preview = _preview(pos);
            Exit memory e = _exit(pos);
            assertEq(e.toUser, preview.toUser);
            assertEq(e.memeToUser, preview.memeToUser);
            assertEq(e.toTreasury, preview.toTreasury);
            assertEq(e.burned, preview.burned);
            Exit memory done = _preview(pos);
            assertEq(done.toUser + done.memeToUser + done.toTreasury + done.burned, 0);
            vm.revertToState(snap);
        }
    }

    // -------------------------------------------------------------------------
    // Shared inventory
    // -------------------------------------------------------------------------

    /// @dev Base, boost and credit draw from one inventory, first come first served. Under the fixed 80/20 template
    ///      split a correct root cannot oversubscribe the reserve (base + 10% boosts + 10% credits <= 1.2 * basePool),
    ///      so the campaign's reserve is shrunk in storage to exercise the guard.
    function test_activateGrant_sharedInventory_firstComeFirstServed() public {
        address meme = _activeDefault(keccak256("inventory"));
        _registerDefault(meme);
        _setReserve(meme, 3_000_000 ether);
        assertEq(t.vault.inventoryRemaining(meme), 3_000_000 ether);

        _activate(meme, bob, BOB_BASE, BOB_BOOST, 0); // bob's base earns his boost, which he takes too
        _activate(meme, carol, CAROL_BASE, 0, 0);
        uint256 remaining = t.vault.inventoryRemaining(meme);
        assertApproxEqAbs(remaining, 3_000_000 ether - BOB_BASE - BOB_BOOST - CAROL_BASE, 1e6); // liquidity rounding
        assertEq(t.vault.allocation(meme, alice).inviterCreditEarned, BOB_BASE / 10);

        // alice's base alone is more than is left: the boost bob took and carol's base came first
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IPerkLPGrantVault.InsufficientInventory.selector, remaining));
        t.vault.activateGrant(meme, ALICE_BASE, 0, 0, type(uint128).max, 0);
        // her credit competes for the same inventory as her base
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IPerkLPGrantVault.InsufficientInventory.selector, remaining));
        t.vault.activateGrant(meme, remaining, 0, 1 ether, type(uint128).max, 0);

        _activate(meme, alice, remaining - BOB_BASE / 10, 0, BOB_BASE / 10);
        uint256 left = t.vault.inventoryRemaining(meme);
        assertLe(left, 1e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IPerkLPGrantVault.InsufficientInventory.selector, left));
        t.vault.activateGrant(meme, 1 ether, 0, 0, type(uint128).max, 0);
        IPerkLPGrantVault.Campaign memory c = t.vault.campaign(meme);
        assertEq(c.reserve - c.totalActivated, left);
    }

    // -------------------------------------------------------------------------
    // Boosts and credits
    // -------------------------------------------------------------------------

    /// @dev The invitee boost is earned as base is activated, 10% of it, up to the leaf's boost; the inviter earns
    ///      10% of the invitee's base activated, up to 50% of the inviter's own base. Boost and credit activations earn
    ///      nothing.
    function test_boostAndCredit_earnedOnlyByBaseActivation_capped_noRecursion() public {
        uint256 aliceBase = 100_000 ether;
        uint256 bobBoostCap = 50_000 ether; // under 10% of bob's base: the cap binds
        bytes32[] memory tree = new bytes32[](4);
        tree[0] = MerkleTree.leaf(alice, aliceBase, 0);
        tree[1] = MerkleTree.leaf(bob, BOB_BASE, bobBoostCap);
        tree[2] = MerkleTree.leaf(carol, CAROL_BASE, 0);
        tree[3] = MerkleTree.leaf(address(0xdead), 0, 0);
        address meme = _graduated(t.erc20Quote, keccak256("earn"));
        _proposeAndActivateRoot(meme, MerkleTree.root(tree), aliceBase + BOB_BASE + CAROL_BASE, bobBoostCap);
        t.vault.registerAllocation(meme, _leafStruct(alice, aliceBase, 0), MerkleTree.proof(tree, 0));
        t.vault.registerAllocation(meme, _leafStruct(bob, BOB_BASE, bobBoostCap), MerkleTree.proof(tree, 1));

        (, uint256 boost,) = t.vault.grantBreakdown(meme, bob);
        assertEq(boost, 0, "nothing earned before base is activated");

        vm.expectEmit(true, true, false, true, address(t.vault));
        emit InviteeBoostEarned(meme, bob, 30_000 ether);
        vm.expectEmit(true, true, true, true, address(t.vault));
        emit InviterCreditEarned(meme, alice, bob, 30_000 ether);
        _activate(meme, bob, 300_000 ether, 0, 0);
        IPerkLPGrantVault.Allocation memory b = t.vault.allocation(meme, bob);
        assertEq(b.baseActivated, 300_000 ether);
        assertEq(b.boostEarned, 30_000 ether);

        // a boost activation earns neither more boost nor a credit
        _activate(meme, bob, 0, 30_000 ether, 0);
        assertEq(t.vault.allocation(meme, bob).boostEarned, 30_000 ether);
        assertEq(t.vault.allocation(meme, alice).inviterCreditEarned, 30_000 ether);
        vm.prank(bob);
        vm.expectRevert(IPerkLPGrantVault.ExceedsClaimable.selector);
        t.vault.activateGrant(meme, 0, 1 ether, 0, 1 ether, 0);

        // more base: the boost stops at the leaf's cap, the credit at 50% of alice's base
        vm.expectEmit(true, true, false, true, address(t.vault));
        emit ReferralCreditCapped(meme, alice, 40_000 ether, 20_000 ether);
        _activate(meme, bob, 400_000 ether, 0, 0);
        b = t.vault.allocation(meme, bob);
        assertEq(b.boostEarned, bobBoostCap, "capped by the leaf's boost, not 10% of 700k");
        assertEq(t.vault.allocation(meme, alice).inviterCreditEarned, aliceBase / 2);
        (, boost,) = t.vault.grantBreakdown(meme, bob);
        assertEq(boost, bobBoostCap - 30_000 ether);

        // alice activates her credit and some base: neither earns her anything (she has no inviter) nor bob
        _activate(meme, alice, 10_000 ether, 0, aliceBase / 2);
        IPerkLPGrantVault.Allocation memory a = t.vault.allocation(meme, alice);
        assertEq(a.inviterCreditActivated, aliceBase / 2);
        assertEq(a.inviterCreditEarned, aliceBase / 2);
        assertEq(a.boostEarned, 0);
        assertEq(t.vault.allocation(meme, bob).boostEarned, bobBoostCap);

        // earned boosts and credits expire with the window
        vm.warp(t.vault.campaign(meme).endTime);
        (, boost,) = t.vault.grantBreakdown(meme, bob);
        assertEq(boost, 0);
    }

    // -------------------------------------------------------------------------
    // Manipulation around one's own exit
    // -------------------------------------------------------------------------

    /// @dev The self-buy extraction: a second wallet pumps the pool, the position exits into the pump, the wallet
    ///      sells back. Valued at the reference price the attacker's combined result is a loss for every pump size,
    ///      at least the PRD's D(sqrt r - 1)^2 / (2 sqrt r); valued at spot the same exit would have paid more.
    function test_pumpAroundExit_withSecondWallet_doesNotPay() public {
        (address meme, uint256 pos) = _open(keccak256("pump"));
        IPerkLPGrantVault.GrantPosition memory p = t.vault.position(pos);
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        t.vault.collectGrantFees(pos);
        (, int24 refTick) = t.hook.referencePrice(_poolId(meme));
        uint160 ref = TickMath.getSqrtPriceAtTick(refTick);

        uint256 snap = vm.snapshotState();
        _exit(pos);
        uint256 honest = _wealth(meme, ref);
        vm.revertToState(snap);

        uint256[4] memory sqrtR = [uint256(1.05e18), 1.3e18, 2e18, 4e18];
        for (uint256 i; i < sqrtR.length; ++i) {
            snap = vm.snapshotState();
            uint256 memeBefore = IERC20(meme).balanceOf(swapper);
            _moveTo(meme, _targetSqrt(meme, ref, sqrtR[i]));
            uint256 bought = IERC20(meme).balanceOf(swapper) - memeBefore;
            Exit memory e = _exit(pos); // never refused, however far the pool is from the reference
            // what a spot-valued exit would have paid instead: (1 - g) of the position at the pumped price
            uint256 spotPaid = Math.mulDiv(
                e.toUser + e.toTreasury + _memeValueInQuote(meme, e.memeToUser + e.burned),
                1e18 - p.protocolShareWad,
                1e18
            );
            _sellMeme(t.graduation.graduationOf(meme).key, _quoteIs0(meme), meme, bought);
            uint256 attacked = _wealth(meme, ref);

            uint256 s = sqrtR[i];
            uint256 theory = Math.mulDiv(p.quoteDeposited, (s - 1e18) * (s - 1e18), 2 * s * 1e18);
            emit log_named_uint("sqrt(r) wad", s);
            emit log_named_int("  attacker result vs honest (quote wei)", int256(attacked) - int256(honest));
            emit log_named_uint("  PRD bound on the loss", theory);
            emit log_named_uint("  extra a spot-valued exit would pay", spotPaid - e.toUser);
            assertLt(attacked, honest, "pumping around one's own exit does not pay");
            assertLe(attacked + theory, honest, "the loss is at least D(sqrt r - 1)^2 / (2 sqrt r)");
            assertGt(e.toTreasury, 0, "the pumped quote beyond the user's share is retired");
            assertGt(spotPaid, e.toUser, "the reference price is what refuses the extraction");
            vm.revertToState(snap);
        }
    }

    /// @dev The mirror image: a second wallet dumps meme, the position exits into the crash taking its shortfall in
    ///      meme at the reference price, the wallet buys the meme back. The attacker ends with less, at least the
    ///      PRD's G(1 - sqrt s)^2 / (2 sqrt s) in meme.
    function test_dumpAroundExit_losesMeme() public {
        (address meme, uint256 pos) = _open(keccak256("dump"));
        IPerkLPGrantVault.GrantPosition memory p = t.vault.position(pos);
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        t.vault.collectGrantFees(pos);
        PoolKey memory key = t.graduation.graduationOf(meme).key;
        (, int24 refTick) = t.hook.referencePrice(_poolId(meme));
        uint160 ref = TickMath.getSqrtPriceAtTick(refTick);

        uint256 snap = vm.snapshotState();
        _exit(pos);
        uint256 honest = _wealthInMeme(meme, ref);
        vm.revertToState(snap);

        uint256[4] memory sqrtS = [uint256(0.95e18), 0.8e18, 0.6e18, 0.5e18];
        for (uint256 i; i < sqrtS.length; ++i) {
            snap = vm.snapshotState();
            uint256 memeBefore = IERC20(meme).balanceOf(swapper);
            _moveTo(meme, _targetSqrt(meme, ref, sqrtS[i]));
            uint256 dumped = memeBefore - IERC20(meme).balanceOf(swapper);
            Exit memory e = _exit(pos); // never refused
            assertGt(e.memeToUser, 0, "the shortfall is paid in meme at the reference price");
            _buyExactMeme(key, _quoteIs0(meme), dumped);
            uint256 attacked = _wealthInMeme(meme, ref);

            uint256 s = sqrtS[i];
            uint256 theory = Math.mulDiv(p.grantMemeAmount, (1e18 - s) * (1e18 - s), 2 * s * 1e18);
            emit log_named_uint("sqrt(s) wad", s);
            emit log_named_int("  attacker result vs honest (meme wei)", int256(attacked) - int256(honest));
            emit log_named_uint("  PRD bound on the loss", theory);
            assertLt(attacked, honest, "dumping around one's own exit loses meme");
            assertLe(attacked + theory, honest, "the loss is at least G(1 - sqrt s)^2 / (2 sqrt s)");
            vm.revertToState(snap);
        }
    }

    /// @dev Exits are never refused on price: sixteenfold up or about sixfold down from the reference, in the exit's
    ///      own block.
    function test_exitGrantPosition_neverRefusedOnPrice() public {
        (address meme, uint256 pos) = _open(keccak256("never-refused"));
        IPerkLPGrantVault.GrantPosition memory p = t.vault.position(pos);
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        uint256[2] memory sqrtR = [uint256(4e18), 0.4e18];
        for (uint256 i; i < sqrtR.length; ++i) {
            uint256 snap = vm.snapshotState();
            _moveTo(meme, _targetSqrt(meme, p.entrySqrtPriceX96, sqrtR[i]));
            (int24 spotTick, int24 refTick) = t.hook.referencePrice(_poolId(meme));
            int256 gap = int256(spotTick) - int256(refTick);
            assertGt(gap < 0 ? -gap : gap, 15_000);
            Exit memory e = _exit(pos);
            assertTrue(t.vault.position(pos).exited);
            assertGt(e.toUser, 0);
            vm.revertToState(snap);
        }
    }

    /// @dev The refund of unused native quote is the one call to the caller and comes last. A contract beneficiary
    ///      whose receive() crashes the pool used to have g, and its entry price, read after that crash: g near zero,
    ///      so its exit took almost the whole position. g and the entry price now come from the prices read before.
    function test_activateGrant_nativeRefundCallback_cannotMoveProtocolShare() public {
        address meme = _graduated(t.nativeQuote, keccak256("refund-callback"));
        PoolKey memory key = t.graduation.graduationOf(meme).key;
        RefundCallbackBeneficiary attacker = new RefundCallbackBeneficiary(t.vault, swapRouter, key, meme);
        bytes32[] memory tree = new bytes32[](2);
        tree[0] = MerkleTree.leaf(address(attacker), ALICE_BASE, 0);
        tree[1] = MerkleTree.leaf(address(0xdead), 0, 0);
        _proposeAndActivateRoot(meme, MerkleTree.root(tree), ALICE_BASE, 0);
        t.vault.registerAllocation(meme, _leafStruct(address(attacker), ALICE_BASE, 0), MerkleTree.proof(tree, 0));
        uint256 inventory = IERC20(meme).balanceOf(buyer);
        vm.prank(buyer);
        IERC20(meme).transfer(address(attacker), inventory);

        uint160 sqrtBefore = _sqrtPriceOf(meme);
        (, int24 refTick) = t.hook.referencePrice(_poolId(meme));
        (uint256 need,) = t.vault.quoteRequired(meme, ALICE_BASE);
        // meme is currency1 against native quote: its price falls tenfold as the sqrt price rises by sqrt(10)
        attacker.arm(uint160(Math.mulDiv(sqrtBefore, 3_162_277_660_168_379_332, 1e18)));
        vm.deal(address(attacker), need + 1);
        uint256 pos = attacker.activate(ALICE_BASE, need + 1);

        assertFalse(attacker.armed(), "the refund reached the callback");
        (, int24 spotAfter,,) = StateLibrary.getSlot0(manager, key.toId());
        int24 spotBefore = TickMath.getTickAtSqrtPrice(sqrtBefore);
        assertGt(int256(spotAfter) - int256(spotBefore), 15_000, "the callback crashed the pool");
        IPerkLPGrantVault.GrantPosition memory p = t.vault.position(pos);
        assertEq(p.entrySqrtPriceX96, sqrtBefore);
        uint256 expected = _expectedShare(meme, p, sqrtBefore, refTick);
        assertEq(p.protocolShareWad, expected, "g from the prices before the callback");
        assertApproxEqRel(p.protocolShareWad, 0.5e18, 1e15);
        assertLt(_expectedShare(meme, p, _sqrtPriceOf(meme), spotAfter), expected / 2, "the crash would have moved g");
    }

    /// @dev Self-sandwich at activation: push the meme price down to just inside the activation band, activate (the
    ///      grant meme is paired with less quote), buy the price back and later exit. g values the grant meme at the
    ///      larger of the spot and reference prices, so the cheaper entry buys no larger share: the round trip loses.
    ///      One tick further and activation is refused.
    function test_activateGrant_selfSandwichInsideTheBand_doesNotPay() public {
        address meme = _activeDefault(keccak256("sandwich"));
        _registerDefault(meme);
        _arm(meme);
        bool memeIs0 = t.vault.campaign(meme).memeIsCurrency0;
        uint160 p0 = _sqrtPriceOf(meme);
        (, int24 refTick) = t.hook.referencePrice(_poolId(meme));

        uint256 snap = vm.snapshotState();
        uint256 honestPos = _activate(meme, alice, ALICE_BASE, 0, 0);
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        _exit(honestPos);
        uint256 honest = _wealth(meme, p0);
        vm.revertToState(snap);

        snap = vm.snapshotState();
        _moveTo(meme, TickMath.getSqrtPriceAtTick(memeIs0 ? refTick - 501 : refTick + 501));
        (uint256 q,) = t.vault.quoteRequired(meme, ALICE_BASE);
        vm.prank(alice);
        vm.expectPartialRevert(IPerkLPGrantVault.PriceUnstable.selector);
        t.vault.activateGrant(meme, ALICE_BASE, 0, 0, q + q / 100 + 1, 0);
        vm.revertToState(snap);

        _moveTo(meme, TickMath.getSqrtPriceAtTick(memeIs0 ? refTick - 499 : refTick + 499));
        (int24 spot, int24 ref) = t.hook.referencePrice(_poolId(meme));
        int256 gap = int256(spot) - int256(ref);
        assertGe(gap < 0 ? -gap : gap, 499, "just inside the band");
        uint256 pos = _activate(meme, alice, ALICE_BASE, 0, 0);
        IPerkLPGrantVault.GrantPosition memory p = t.vault.position(pos);
        assertGt(p.protocolShareWad, 0.51e18, "the grant meme is valued at the reference");
        _moveTo(meme, p0); // buy the price back
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        _exit(pos);
        uint256 attacked = _wealth(meme, p0);
        emit log_named_int("sandwich result vs honest (quote wei)", int256(attacked) - int256(honest));
        assertLe(attacked, honest, "the self-sandwich does not pay");
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    /// @dev A default campaign with alice's full base activated; the swapper holds the buyer's meme inventory.
    function _open(bytes32 salt) internal returns (address meme, uint256 pos) {
        meme = _activeDefault(salt);
        _registerDefault(meme);
        pos = _activate(meme, alice, ALICE_BASE, 0, 0);
        _arm(meme);
    }

    /// @dev Hands the buyer's meme inventory to the swapper, approved for the swap router.
    function _arm(address meme) internal {
        uint256 inventory = IERC20(meme).balanceOf(buyer);
        vm.prank(buyer);
        IERC20(meme).transfer(swapper, inventory);
        vm.prank(swapper);
        IERC20(meme).approve(address(swapRouter), type(uint256).max);
    }

    /// @dev g as the vault must fix it, computed here independently: the grant meme valued at the spot price the
    ///      position opened at and at the reference tick, the larger share, rounded up.
    function _expectedShare(address meme, IPerkLPGrantVault.GrantPosition memory p, uint160 sqrtSpot, int24 refTick)
        internal
        view
        returns (uint256)
    {
        uint256 atSpot = _memeValueInQuoteAt(meme, p.grantMemeAmount, sqrtSpot);
        uint256 atRef = _memeValueInQuoteAt(meme, p.grantMemeAmount, TickMath.getSqrtPriceAtTick(refTick));
        return Math.max(
            Math.mulDiv(atSpot, 1e18, atSpot + p.quoteDeposited, Math.Rounding.Ceil),
            Math.mulDiv(atRef, 1e18, atRef + p.quoteDeposited, Math.Rounding.Ceil)
        );
    }

    function _exit(uint256 pos) internal returns (Exit memory e) {
        vm.prank(alice);
        (e.toUser, e.memeToUser, e.toTreasury, e.burned) = t.vault.exitGrantPosition(pos, 0, 0);
    }

    function _preview(uint256 pos) internal view returns (Exit memory e) {
        (e.toUser, e.memeToUser, e.toTreasury, e.burned) = t.vault.exitPreview(pos);
    }

    function _poolId(address meme) internal view returns (PoolId) {
        return t.graduation.graduationOf(meme).poolId;
    }

    /// @dev The v4 sqrt price at which the meme's quote price is `sqrtRWad^2` times its price at `from`.
    function _targetSqrt(address meme, uint160 from, uint256 sqrtRWad) internal view returns (uint160) {
        if (t.vault.campaign(meme).memeIsCurrency0) return uint160(Math.mulDiv(from, sqrtRWad, 1e18));
        return uint160(Math.mulDiv(from, 1e18, sqrtRWad));
    }

    /// @dev sqrt(meme price at `to` / meme price at `from`), wad.
    function _realSqrtR(address meme, uint160 from, uint160 to) internal view returns (uint256) {
        if (t.vault.campaign(meme).memeIsCurrency0) return Math.mulDiv(to, 1e18, from);
        return Math.mulDiv(from, 1e18, to);
    }

    /// @dev Moves the pool exactly to `target` with a price-limited swap by the swapper: an exact-output meme buy
    ///      or an exact-input meme sale, so the hook's fee is charged on the quote actually traded.
    function _moveTo(address meme, uint160 target) internal {
        uint160 cur = _sqrtPriceOf(meme);
        if (target == cur) return;
        PoolKey memory key = t.graduation.graduationOf(meme).key;
        bool zeroForOne = target < cur;
        bool memeIn = zeroForOne == t.vault.campaign(meme).memeIsCurrency0;
        int256 amountSpecified = memeIn
            // forge-lint: disable-next-line(unsafe-typecast)
            ? -int256(IERC20(meme).balanceOf(swapper))
            : int256(1e30);
        vm.prank(swapper);
        swapRouter.swap(
            key,
            SwapParams({zeroForOne: zeroForOne, amountSpecified: amountSpecified, sqrtPriceLimitX96: target}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            bytes("")
        );
        assertEq(_sqrtPriceOf(meme), target, "the pool reached the target price");
    }

    function _buyExactMeme(PoolKey memory key, bool q0, uint256 amount) internal {
        vm.prank(swapper);
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: q0,
                // forge-lint: disable-next-line(unsafe-typecast)
                amountSpecified: int256(amount),
                sqrtPriceLimitX96: q0 ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            bytes("")
        );
    }

    /// @dev The attacker (alice's position wallet plus the swapper) in quote, meme valued at `sqrtP`.
    function _wealth(address meme, uint160 sqrtP) internal view returns (uint256) {
        uint256 q = t.quoteToken.balanceOf(alice) + t.quoteToken.balanceOf(swapper);
        uint256 m = IERC20(meme).balanceOf(alice) + IERC20(meme).balanceOf(swapper);
        return q + _memeValueInQuoteAt(meme, m, sqrtP);
    }

    /// @dev The same in meme, quote converted at `sqrtP`.
    function _wealthInMeme(address meme, uint160 sqrtP) internal view returns (uint256) {
        uint256 q = t.quoteToken.balanceOf(alice) + t.quoteToken.balanceOf(swapper);
        uint256 m = IERC20(meme).balanceOf(alice) + IERC20(meme).balanceOf(swapper);
        uint256 q96 = 1 << 96;
        uint256 qInMeme = t.vault.campaign(meme).memeIsCurrency0
            ? Math.mulDiv(Math.mulDiv(q, q96, sqrtP), q96, sqrtP)
            : Math.mulDiv(Math.mulDiv(q, sqrtP, q96), sqrtP, q96);
        return m + qInMeme;
    }

    /// @dev Test-only: shrinks the campaign's reserve in storage (found by value) to simulate an oversubscribed one.
    function _setReserve(address meme, uint256 newReserve) internal {
        uint256 reserve = t.vault.campaign(meme).reserve;
        for (uint256 m; m < 32; ++m) {
            uint256 base = uint256(keccak256(abi.encode(meme, m)));
            for (uint256 j; j < 40; ++j) {
                bytes32 slot = bytes32(base + j);
                if (uint256(vm.load(address(t.vault), slot)) == reserve) {
                    vm.store(address(t.vault), slot, bytes32(newReserve));
                    assertEq(t.vault.campaign(meme).reserve, newReserve);
                    return;
                }
            }
        }
        revert("reserve slot not found");
    }
}

/// @dev A contract beneficiary that crashes the pool from its receive() when the vault refunds unused native quote.
contract RefundCallbackBeneficiary {
    IPerkLPGrantVault internal immutable VAULT;
    PoolSwapTest internal immutable ROUTER;
    address internal immutable MEME;
    PoolKey internal key;
    uint160 internal limit;
    bool public armed;

    constructor(IPerkLPGrantVault vault_, PoolSwapTest router_, PoolKey memory key_, address meme_) {
        VAULT = vault_;
        ROUTER = router_;
        key = key_;
        MEME = meme_;
    }

    function arm(uint160 limit_) external {
        limit = limit_;
        armed = true;
    }

    function activate(uint256 base, uint256 quoteMax) external returns (uint256) {
        return VAULT.activateGrant{value: quoteMax}(MEME, base, 0, 0, quoteMax, 0);
    }

    receive() external payable {
        if (!armed) return;
        armed = false;
        IERC20(MEME).approve(address(ROUTER), type(uint256).max);
        ROUTER.swap(
            key,
            SwapParams({
                zeroForOne: false,
                // forge-lint: disable-next-line(unsafe-typecast)
                amountSpecified: -int256(IERC20(MEME).balanceOf(address(this))),
                sqrtPriceLimitX96: limit
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            bytes("")
        );
    }
}

/// @dev Exit settlement conservation across both pool orientations and 18- and 6-decimal quotes, with the pool
///      moved either way in the exit's own block: the quote the burn returns is split exactly between beneficiary and
///      treasury, the meme exactly between beneficiary and burn, nothing reverts, and exitPreview is the exit.
contract LPGrantVaultSettlementFuzzTest is GrantTestBase {
    using CurrencyLibrary for Currency;
    using PoolIdLibrary for PoolKey;

    uint256 internal constant BASE = 1_000_000 ether;
    MockERC20 internal stock;
    Currency internal stockQuote;
    bytes32 internal stockTemplate;

    function setUp() public {
        _setUpPerk();
        stock = new MockERC20("Tokenized AAPL", "tAAPL", 6);
        stockQuote = Currency.wrap(address(stock));
        t.assetRegistry
            .setAsset(
                stockQuote,
                PerkTypes.AssetInfo({
                    enabled: true, rewardCompatible: true, isNative: false, decimals: 6, symbol: "tAAPL"
                })
            );
        bytes32[5] memory mods = [
            PerkConstants.MODULE_ID_OFFICIAL_POOL_GUARD,
            PerkConstants.MODULE_ID_QUOTE_FEE_ROUTER,
            PerkConstants.MODULE_ID_HOLDER_QUOTE_REWARD,
            PerkConstants.MODULE_ID_LP_GRANT,
            PerkConstants.MODULE_ID_REFERRAL_GRANT_BOOST
        ];
        for (uint256 i; i < mods.length; ++i) {
            t.moduleRegistry.setQuoteCompatibility(mods[i], 1, stockQuote, true);
        }
        PerkTemplates.Numbers memory n = PerkTemplates.forQuote(PerkTemplates.defaultNumbers(), stockQuote, 6);
        stockTemplate = PerkTemplates.templateIdFor(PerkConstants.TEMPLATE_PERK_GRANT_V1, stockQuote);
        t.templateRegistry.registerTemplate(stockTemplate, PerkTemplates.perkGrantV1(n));
        address[4] memory who = [creator, buyer, swapper, alice];
        for (uint256 i; i < who.length; ++i) {
            stock.mint(who[i], 1_000_000e6);
            vm.startPrank(who[i]);
            stock.approve(address(t.factory), type(uint256).max);
            stock.approve(address(t.curve), type(uint256).max);
            stock.approve(address(swapRouter), type(uint256).max);
            stock.approve(address(t.vault), type(uint256).max);
            vm.stopPrank();
        }
    }

    /// forge-config: default.fuzz.runs = 16
    function testFuzz_exitSettlement_conservesPrincipal(uint256 seed) public {
        for (uint256 k; k < 4; ++k) {
            uint256 snap = vm.snapshotState();
            _checkSettlement(seed, k >= 2, k % 2 == 0);
            vm.revertToState(snap);
        }
    }

    function _checkSettlement(uint256 seed, bool six, bool wantMeme0) internal {
        Currency quote = six ? stockQuote : t.erc20Quote;
        address meme = _launchOnSide(seed, six, quote, wantMeme0);
        assertEq(t.vault.campaign(meme).memeIsCurrency0, wantMeme0);

        IPerkLPGrantVault.GrantLeaf memory leaf = _leafStruct(alice, BASE, 0);
        _proposeAndActivateRoot(meme, t.vault.leafHash(leaf), BASE, 0);
        t.vault.registerAllocation(meme, leaf, new bytes32[](0));
        uint256 pos = _activate(meme, alice, BASE, 0, 0);
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);

        // a move in the exit's own block, up or down, possibly far from the reference
        PoolKey memory key = t.graduation.graduationOf(meme).key;
        bool q0 = !wantMeme0;
        uint256 mode = seed % 3;
        if (mode == 0) {
            _swap(key, q0, bound(seed >> 8, six ? 1e3 : 1e15, six ? 150e6 : 150 ether), 0);
        } else if (mode == 1) {
            uint256 inventory = IERC20(meme).balanceOf(buyer);
            vm.prank(buyer);
            IERC20(meme).transfer(swapper, inventory);
            _sellMeme(key, q0, meme, bound(seed >> 8, 1 ether, inventory));
        }
        t.vault.collectGrantFees(pos);

        (uint256 memeOut, uint256 quoteOut) = _principalNow(meme, t.vault.position(pos).liquidity);
        (uint256 pq, uint256 pm, uint256 pt, uint256 pb) = t.vault.exitPreview(pos);
        uint256 aliceQuote = quote.balanceOf(alice);
        uint256 aliceMeme = IERC20(meme).balanceOf(alice);
        uint256 treasuryQuote = quote.balanceOf(address(t.treasury));
        uint256 vaultMeme = IERC20(meme).balanceOf(address(t.vault));
        vm.prank(alice);
        (uint256 toUser, uint256 memeToUser, uint256 toTreasury, uint256 burned) = t.vault.exitGrantPosition(pos, 0, 0);

        assertEq(toUser + toTreasury, quoteOut, "quote conserved");
        assertEq(memeToUser + burned, memeOut, "meme conserved");
        assertEq(toUser, pq);
        assertEq(memeToUser, pm);
        assertEq(toTreasury, pt);
        assertEq(burned, pb);
        if (memeToUser > 0) assertEq(toTreasury, 0, "quote is paid first");
        assertEq(quote.balanceOf(alice) - aliceQuote, toUser);
        assertEq(IERC20(meme).balanceOf(alice) - aliceMeme, memeToUser);
        assertEq(quote.balanceOf(address(t.treasury)) - treasuryQuote, toTreasury);
        assertEq(IERC20(meme).balanceOf(address(t.vault)), vaultMeme);
        assertEq(quote.balanceOf(address(t.vault)), 0);
    }

    /// @dev Creates and graduates a grant launch whose meme sorts on the wanted side of the quote.
    function _launchOnSide(uint256 seed, bool six, Currency quote, bool wantMeme0) internal returns (address meme) {
        bytes32 templateId = six ? stockTemplate : PerkConstants.TEMPLATE_PERK_GRANT_V1;
        bytes32 salt;
        for (uint256 i;; ++i) {
            assertLt(i, 64, "no salt on the wanted side");
            salt = keccak256(abi.encode(seed, six, i));
            PerkTypes.CreateLaunchParams memory p;
            p.templateId = templateId;
            p.quote = quote;
            p.metadata = PerkTypes.TokenMetadata({name: "Frog", symbol: "FROG", uri: "ipfs://frog"});
            p.salt = salt;
            vm.prank(creator);
            (address predicted,,,) = t.factory.previewLaunch(p);
            if ((predicted < Currency.unwrap(quote)) == wantMeme0) break;
        }
        meme = _createLaunch(templateId, quote, salt);
        vm.prank(buyer);
        t.curve.buy(meme, six ? 100e6 : BUY_GROSS, 0, buyer);
        t.graduation.graduate(meme);
    }

    /// @dev What burning `liquidity` of the full range returns at the pool's price now, computed from v4 math.
    function _principalNow(address meme, uint128 liquidity) internal view returns (uint256 memeOut, uint256 quoteOut) {
        IPerkLPGrantVault.Campaign memory c = t.vault.campaign(meme);
        (uint160 sqrtP, int24 tick,,) = StateLibrary.getSlot0(manager, c.key.toId());
        assertTrue(tick >= c.tickLower && tick < c.tickUpper, "in range");
        uint256 amount0 =
            SqrtPriceMath.getAmount0Delta(sqrtP, TickMath.getSqrtPriceAtTick(c.tickUpper), liquidity, false);
        uint256 amount1 =
            SqrtPriceMath.getAmount1Delta(TickMath.getSqrtPriceAtTick(c.tickLower), sqrtP, liquidity, false);
        (memeOut, quoteOut) = c.memeIsCurrency0 ? (amount0, amount1) : (amount1, amount0);
    }
}
// forge-lint: disable-end(environment-read-across-mutation)
