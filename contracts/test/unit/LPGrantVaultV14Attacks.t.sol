// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

// forge-lint: disable-start(environment-read-across-mutation)

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {Actions} from "v4-periphery/src/libraries/Actions.sol";

import {IPerkLPGrantVault} from "../../src/interfaces/IPerkLPGrantVault.sol";
import {IPerkGraduationManager} from "../../src/interfaces/IPerkGraduationManager.sol";
import {PerkConstants} from "../../src/libraries/PerkConstants.sol";
import {PerkTypes} from "../../src/libraries/PerkTypes.sol";
import {PerkTemplates} from "../../script/lib/PerkTemplates.sol";
import {MockERC20} from "../utils/MockERC20.sol";
import {GrantHandler} from "./LPGrantVaultEdge.t.sol";
import {GrantTestBase} from "../utils/GrantTestBase.sol";
import {MerkleTree} from "../utils/MerkleTree.sol";

/// @dev Shared scenario plumbing for the v0.14 adversarial suite: a campaign whose attacker position (alice, with the
///      swapper as the attacker's trading wallet) sits next to the locked initial LP and other grant positions, sized
///      to a chosen share of the pool's liquidity, plus price-moving and wealth helpers. P&L is always measured in
///      quote at P0, the reference tick's price when the attack starts, against an honest exit from the same state.
abstract contract V14AttackBase is GrantTestBase {
    using PoolIdLibrary for PoolKey;

    uint256 internal constant WAD = 1e18;
    uint256 internal constant ATTACKER_BASE = 110_000_000 ether; // basePool is 120M: alice + bob + carol fit
    uint256 internal constant PROBE = 1_000_000 ether;

    uint256 internal constant SQRT_1_05 = 1_024_695_076_595_959_838;
    uint256 internal constant SQRT_2 = 1_414_213_562_373_095_048;
    uint256 internal constant SQRT_10 = 3_162_277_660_168_379_332;
    uint256 internal constant SQRT_0_5 = 707_106_781_186_547_524;
    uint256 internal constant SQRT_0_1 = 316_227_766_016_837_933;

    struct Exit {
        uint256 toUser;
        uint256 memeToUser;
        uint256 toTreasury;
        uint256 burned;
    }

    /// @dev One attack: the campaign, the attacker's position and the prices the attack starts from.
    struct Scene {
        address meme;
        uint256 pos;
        uint160 sqrt0; // pool price when the attack starts
        int24 refTick; // reference tick when the attack starts
        uint160 p0; // sqrt price of refTick: P0, the valuation price
        uint256 lambdaWad; // the position's share of the pool's active liquidity when it opened
    }

    bytes32[] internal tree;

    /// @dev Graduated ERC-20-quote campaign: alice may take up to ATTACKER_BASE, bob and carol already hold ordinary
    ///      grant positions, and the swapper holds the buyer's whole meme inventory.
    function _campaignWithOthers(bytes32 salt) internal returns (address meme) {
        tree = new bytes32[](4);
        tree[0] = MerkleTree.leaf(alice, ATTACKER_BASE, 0);
        tree[1] = MerkleTree.leaf(bob, BOB_BASE, BOB_BOOST);
        tree[2] = MerkleTree.leaf(carol, CAROL_BASE, 0);
        tree[3] = MerkleTree.leaf(address(0xdead), 0, 0);
        meme = _graduated(t.erc20Quote, salt);
        _proposeAndActivateRoot(meme, MerkleTree.root(tree), ATTACKER_BASE + BOB_BASE + CAROL_BASE, BOB_BOOST);
        t.vault.registerAllocation(meme, _leafStruct(alice, ATTACKER_BASE, 0), MerkleTree.proof(tree, 0));
        t.vault.registerAllocation(meme, _leafStruct(bob, BOB_BASE, BOB_BOOST), MerkleTree.proof(tree, 1));
        t.vault.registerAllocation(meme, _leafStruct(carol, CAROL_BASE, 0), MerkleTree.proof(tree, 2));
        _activate(meme, bob, BOB_BASE, BOB_BOOST, 0);
        _activate(meme, carol, CAROL_BASE, 0, 0);
        _arm(meme);
    }

    /// @dev Grant meme alice must activate for her position to hold `lambdaBps` of the pool's active liquidity. Under
    ///      the 17.58% pool / 15% grant supply split one grant position tops out near 43% of the liquidity, so for a
    ///      larger share the locked initial LP is thinned (by pranking the locker) until the target fits.
    function _sizeAttacker(address meme, uint256 lambdaBps) internal returns (uint256 amount) {
        uint256 others = StateLibrary.getLiquidity(manager, _poolId(meme));
        (, uint128 perProbe) = t.vault.quoteRequired(meme, PROBE);
        amount = Math.mulDiv(PROBE, Math.mulDiv(others, lambdaBps, 10_000 - lambdaBps), perProbe);
        uint256 cap = (ATTACKER_BASE * 9) / 10;
        if (amount > cap) {
            amount = cap;
            uint256 la = Math.mulDiv(amount, perProbe, PROBE);
            _thinInitialLp(meme, others - Math.mulDiv(la, 10_000 - lambdaBps, lambdaBps));
        }
    }

    /// @dev Test-only: removes `liquidity` from the locked initial LP, which the locker would never do.
    function _thinInitialLp(address meme, uint256 liquidity) internal {
        IPerkGraduationManager.Graduation memory g = t.graduation.graduationOf(meme);
        assertLt(liquidity, t.positionManager.getPositionLiquidity(g.positionTokenId), "initial LP large enough");
        bytes memory actions = abi.encodePacked(_byte(Actions.DECREASE_LIQUIDITY), _byte(Actions.TAKE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(g.positionTokenId, liquidity, uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(g.key.currency0, g.key.currency1, address(0xbeef));
        vm.prank(address(t.locker));
        t.positionManager.modifyLiquidities(abi.encode(actions, params), vm.getBlockTimestamp());
    }

    /// @dev Opens alice's position at `lambdaBps` of the pool's liquidity.
    function _openAttacker(address meme, uint256 lambdaBps) internal returns (Scene memory s) {
        s.meme = meme;
        uint256 amount = _sizeAttacker(meme, lambdaBps);
        s.pos = _activate(meme, alice, amount, 0, 0);
        s.lambdaWad =
            Math.mulDiv(t.vault.position(s.pos).liquidity, WAD, StateLibrary.getLiquidity(manager, _poolId(meme)));
        assertApproxEqRel(s.lambdaWad, lambdaBps * 1e14, 0.02e18, "attacker share of liquidity");
    }

    /// @dev Past the minimum LP time, fees collected (none), and the starting prices recorded.
    function _begin(Scene memory s) internal {
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        vm.roll(vm.getBlockNumber() + 1);
        t.vault.collectGrantFees(s.pos);
        s.sqrt0 = _sqrtPriceOf(s.meme);
        (, s.refTick) = t.hook.referencePrice(_poolId(s.meme));
        s.p0 = TickMath.getSqrtPriceAtTick(s.refTick);
    }

    /// @dev Hands the buyer's meme inventory to the swapper, approved for the swap router.
    function _arm(address meme) internal {
        uint256 inventory = IERC20(meme).balanceOf(buyer);
        vm.prank(buyer);
        IERC20(meme).transfer(swapper, inventory);
        vm.prank(swapper);
        IERC20(meme).approve(address(swapRouter), type(uint256).max);
    }

    function _exitAs(address who, uint256 pos) internal returns (Exit memory e) {
        vm.prank(who);
        (e.toUser, e.memeToUser, e.toTreasury, e.burned) = t.vault.exitGrantPosition(pos, 0, 0);
    }

    function _poolId(address meme) internal view returns (PoolId) {
        return t.graduation.graduationOf(meme).poolId;
    }

    function _memeIs0(address meme) internal view returns (bool) {
        return t.vault.campaign(meme).memeIsCurrency0;
    }

    /// @dev A sqrt price strictly inside `tick`, so a swap ending there leaves the pool's tick at `tick` from either
    ///      side (a swap ending exactly on a boundary going down reports the tick below).
    function _sqrtInTick(int24 tick) internal pure returns (uint160) {
        return TickMath.getSqrtPriceAtTick(tick) + 1;
    }

    /// @dev The v4 sqrt price at which the meme's quote price is `sqrtRWad^2` times its price at `from`.
    function _targetSqrt(address meme, uint160 from, uint256 sqrtRWad) internal view returns (uint160) {
        if (_memeIs0(meme)) return uint160(Math.mulDiv(from, sqrtRWad, WAD));
        return uint160(Math.mulDiv(from, WAD, sqrtRWad));
    }

    /// @dev sqrt(meme price at `to` / meme price at `from`), wad.
    function _realSqrtR(address meme, uint160 from, uint160 to) internal view returns (uint256) {
        if (_memeIs0(meme)) return Math.mulDiv(to, WAD, from);
        return Math.mulDiv(from, WAD, to);
    }

    /// @dev Moves the pool exactly to `target` with a price-limited swap by the swapper: an exact-output meme buy or
    ///      an exact-input meme sale, so the hook fee is charged on the quote actually traded.
    function _moveTo(address meme, uint160 target) internal {
        uint160 cur = _sqrtPriceOf(meme);
        if (target == cur) return;
        PoolKey memory key = t.graduation.graduationOf(meme).key;
        bool zeroForOne = target < cur;
        bool memeIn = zeroForOne == _memeIs0(meme);
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

    /// @dev The attacker (alice's position wallet plus the swapper) in quote, meme valued at `sqrtP`.
    function _wealth(address meme, uint160 sqrtP) internal view returns (uint256) {
        uint256 q = t.quoteToken.balanceOf(alice) + t.quoteToken.balanceOf(swapper);
        uint256 m = IERC20(meme).balanceOf(alice) + IERC20(meme).balanceOf(swapper);
        return q + _memeValueInQuoteAt(meme, m, sqrtP);
    }

    /// @dev Meme units worth `quoteAmount` at `sqrtP`, rounded down, computed here independently of the vault.
    function _quoteToMemeAt(address meme, uint256 quoteAmount, uint160 sqrtP) internal view returns (uint256) {
        uint256 q96 = 1 << 96;
        if (_memeIs0(meme)) return Math.mulDiv(Math.mulDiv(quoteAmount, q96, sqrtP), q96, sqrtP);
        return Math.mulDiv(Math.mulDiv(quoteAmount, sqrtP, q96), sqrtP, q96);
    }

    /// @dev g with the grant meme valued at the reference tick, rounded up: the floor the vault's g never goes below.
    function _refShare(address meme, IPerkLPGrantVault.GrantPosition memory p, int24 refTick)
        internal
        view
        returns (uint256)
    {
        uint256 atRef = _memeValueInQuoteAt(meme, p.grantMemeAmount, TickMath.getSqrtPriceAtTick(refTick));
        return Math.mulDiv(atRef, WAD, atRef + p.quoteDeposited, Math.Rounding.Ceil);
    }

    /// @dev g as the vault must fix it: the larger of the spot- and reference-valued shares, rounded up.
    function _expectedShare(address meme, IPerkLPGrantVault.GrantPosition memory p, uint160 sqrtSpot, int24 refTick)
        internal
        view
        returns (uint256)
    {
        uint256 atSpot = _memeValueInQuoteAt(meme, p.grantMemeAmount, sqrtSpot);
        return
            Math.max(
                Math.mulDiv(atSpot, WAD, atSpot + p.quoteDeposited, Math.Rounding.Ceil), _refShare(meme, p, refTick)
            );
    }

    /// @dev What burning `liquidity` of the full range returns at the pool's price now, from v4 math.
    function _principalNow(address meme, uint128 liquidity) internal view returns (uint256 memeOut, uint256 quoteOut) {
        IPerkLPGrantVault.Campaign memory c = t.vault.campaign(meme);
        (uint160 sqrtP,,,) = StateLibrary.getSlot0(manager, c.key.toId());
        uint256 amount0 =
            SqrtPriceMath.getAmount0Delta(sqrtP, TickMath.getSqrtPriceAtTick(c.tickUpper), liquidity, false);
        uint256 amount1 =
            SqrtPriceMath.getAmount1Delta(TickMath.getSqrtPriceAtTick(c.tickLower), sqrtP, liquidity, false);
        (memeOut, quoteOut) = c.memeIsCurrency0 ? (amount0, amount1) : (amount1, amount0);
    }

    function _byte(uint256 action) internal pure returns (bytes1) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return bytes1(uint8(action));
    }

    function _signed(uint256 x) internal pure returns (int256) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return int256(x);
    }
}

/// @dev PRD 6 v0.14 security argument, attacked: manipulation around one's own exit and activation, with the locked
///      initial LP and other grant positions in the pool, across attacker liquidity shares.
contract LPGrantVaultV14AttacksTest is V14AttackBase {
    using PoolIdLibrary for PoolKey;

    function setUp() public {
        _setUpPerk(); // maxPriceDeviationTicks 500: the deployed value
    }

    // -------------------------------------------------------------------------
    // 2. Same-block pump / dump around one's own exit
    // -------------------------------------------------------------------------

    /// @dev Attacker share of liquidity 1%, 30% and 90% (90% needs a thinned initial LP, see _sizeAttacker). For each,
    ///      pump r in {1.05, 2, 10} and dump s in {0.5, 0.1} with the swapper, exit into the move, trade the pool back
    ///      to where it started. The attacker loses at least the PRD's closed form, D(sqrt r - 1)^2 / (2 sqrt r) for a
    ///      pump and G(1 - sqrt s)^2 / (2 sqrt s) meme for a dump, within a tick; fees only add to the loss.
    function test_pumpDumpAroundExit_lambda1pct_loses() public {
        _pumpDumpAroundExit(keccak256("pd-1"), 100);
    }

    function test_pumpDumpAroundExit_lambda30pct_loses() public {
        _pumpDumpAroundExit(keccak256("pd-30"), 3000);
    }

    function test_pumpDumpAroundExit_lambda90pct_loses() public {
        _pumpDumpAroundExit(keccak256("pd-90"), 9000);
    }

    function _pumpDumpAroundExit(bytes32 salt, uint256 lambdaBps) internal {
        Scene memory s = _openAttacker(_campaignWithOthers(salt), lambdaBps);
        _begin(s);
        IPerkLPGrantVault.GrantPosition memory p = t.vault.position(s.pos);
        emit log_named_uint("lambda (wad)", s.lambdaWad);
        emit log_named_uint("D (quote deposited)", p.quoteDeposited);

        uint256 snap = vm.snapshotState();
        _exitAs(alice, s.pos);
        uint256 honest = _wealth(s.meme, s.p0);
        vm.revertToState(snap);

        uint256[5] memory moves = [SQRT_1_05, SQRT_2, SQRT_10, SQRT_0_5, SQRT_0_1];
        for (uint256 i; i < moves.length; ++i) {
            snap = vm.snapshotState();
            _moveTo(s.meme, _targetSqrt(s.meme, s.p0, moves[i]));
            Exit memory e = _exitAs(alice, s.pos); // never refused, valued at the untouched reference
            _moveTo(s.meme, s.sqrt0); // trade the pool back to where it started
            int256 pnl = _signed(_wealth(s.meme, s.p0)) - _signed(honest);

            uint256 a = moves[i];
            uint256 theory = a > WAD
                ? Math.mulDiv(p.quoteDeposited, (a - WAD) * (a - WAD), 2 * a * WAD)
                : _memeValueInQuoteAt(s.meme, Math.mulDiv(p.grantMemeAmount, (WAD - a) * (WAD - a), 2 * a * WAD), s.p0);
            emit log_named_uint(a > WAD ? "pump sqrt(r) wad" : "dump sqrt(s) wad", a);
            emit log_named_int("  attacker P&L vs honest exit (quote wei at P0)", pnl);
            emit log_named_uint("  closed-form loss", theory);
            emit log_named_uint("  quote to treasury", e.toTreasury);
            emit log_named_uint("  meme burned", e.burned);
            assertLt(pnl, 0, "manipulating around one's own exit loses");
            assertLe(pnl + _signed(theory), _signed(p.quoteDeposited / 10_000), "loss >= closed form (1 tick)");
            vm.revertToState(snap);
        }
    }

    // -------------------------------------------------------------------------
    // 3. Multi-block drag: the known residual
    // -------------------------------------------------------------------------

    /// @dev Known residual (documented in IPerkLPGrantVault.exitGrantPosition). An attacker with 5% of the liquidity
    ///      pumps the pool 8 ticks every second, one block per second, exactly as fast as the reference may follow, so
    ///      the pool is never more than 8 ticks (0.08%) off its reference; after holding T seconds it exits with the
    ///      reference caught up at r = 1.0001^(8T) and trades the pool back. No arbitrageur leans on the pool in this
    ///      test, so holding costs only swap fees. Measured P&L in quote at P0, D = 4.515 quote deposited, reference
    ///      and spot equal at exit (pinned below within 5%):
    ///        held    ticks   sqrt r    P&L        bound D(1 - 1/sqrt r)   P&L / D
    ///        1 s     8       1.0004    +0.00113   0.00181                 +0.03%
    ///        60 s    480     1.0243    +0.0645    0.1071                  +1.4%
    ///        300 s   2400    1.1275    +0.2886    0.5105                  +6.4%
    ///        900 s   7200    1.4333    +0.6211    1.3649                  +13.8%
    ///      The gain is the protocol's meme share sold at the pumped price: with the reference caught up the exit pays
    ///      D sqrt r in quote and burns only G / sqrt r. The ceiling with no fees is D(1 - 1/sqrt r); fees take roughly
    ///      40-55% of it here. Because the pool never sits more than 8 ticks (0.08%) off its reference, well inside
    ///      the 1.15% swap fee, nothing in the pool itself pushes back: what bounds this in practice is the selling
    ///      the pump attracts from other holders and venues, which the attacker must absorb for the whole hold.
    function test_multiBlockDrag_lambda5pct_residualWithinBound() public {
        Scene memory s = _openAttacker(_campaignWithOthers(keccak256("drag")), 500);
        _begin(s);
        IPerkLPGrantVault.GrantPosition memory p = t.vault.position(s.pos);

        uint256 snap = vm.snapshotState();
        _exitAs(alice, s.pos);
        uint256 honest = _wealth(s.meme, s.p0);
        vm.revertToState(snap);

        int24 step = _memeIs0(s.meme) ? int24(8) : int24(-8); // meme price up
        uint256[4] memory holds = [uint256(1), 60, 300, 900];
        int256[4] memory pinned =
            [int256(1_133_342_932_439_166), 64_523_355_280_775_672, 288_578_969_524_077_068, 621_097_539_165_850_463];
        int256[4] memory pnls;
        uint256[4] memory bounds;
        uint256 k;
        for (uint256 sec = 1; sec <= 900; ++sec) {
            vm.warp(vm.getBlockTimestamp() + 1);
            vm.roll(vm.getBlockNumber() + 1);
            // forge-lint: disable-next-line(unsafe-typecast)
            _moveTo(s.meme, _sqrtInTick(s.refTick + step * int24(int256(sec))));
            if (sec != holds[k]) continue;

            snap = vm.snapshotState();
            vm.warp(vm.getBlockTimestamp() + 1); // exit in the next block, before any swap
            vm.roll(vm.getBlockNumber() + 1);
            (int24 spotTick, int24 refTick) = t.hook.referencePrice(_poolId(s.meme));
            assertEq(refTick, spotTick, "the reference has caught up");
            _exitAs(alice, s.pos);
            _moveTo(s.meme, s.sqrt0);
            pnls[k] = _signed(_wealth(s.meme, s.p0)) - _signed(honest);
            uint256 a = _realSqrtR(s.meme, s.p0, TickMath.getSqrtPriceAtTick(refTick));
            bounds[k] = Math.mulDiv(p.quoteDeposited, a - WAD, a);
            emit log_named_uint("held seconds", sec);
            emit log_named_uint("  sqrt(r) wad", a);
            emit log_named_int("  attacker P&L (quote wei at P0)", pnls[k]);
            emit log_named_uint("  bound D(1 - 1/sqrt r)", bounds[k]);
            assertLe(pnls[k], _signed(bounds[k]), "within the analytic bound");
            assertApproxEqRel(pnls[k], pinned[k], 0.05e18, "pinned residual");
            vm.revertToState(snap);
            if (++k == holds.length) break;
        }
        emit log_named_uint("D", p.quoteDeposited);
    }

    // -------------------------------------------------------------------------
    // 4. Atomic activation self-sandwich at the edge of the band
    // -------------------------------------------------------------------------

    /// @dev The attacker moves the pool to exactly 500 ticks off the reference either way, activates, trades the pool
    ///      back in the same block and exits later. g values the grant meme at the larger of the spot and reference
    ///      prices, so no entry price inside the band buys a larger share: the round trip loses after fees for
    ///      attacker liquidity shares of 2%, 5%, 20% and 50%. At 501 ticks activation is refused.
    function test_activationSelfSandwich_lambda2pct() public {
        _selfSandwich(keccak256("ss-2"), 200);
    }

    function test_activationSelfSandwich_lambda5pct() public {
        _selfSandwich(keccak256("ss-5"), 500);
    }

    function test_activationSelfSandwich_lambda20pct() public {
        _selfSandwich(keccak256("ss-20"), 2000);
    }

    function test_activationSelfSandwich_lambda50pct() public {
        _selfSandwich(keccak256("ss-50"), 5000);
    }

    function _selfSandwich(bytes32 salt, uint256 lambdaBps) internal {
        address meme = _campaignWithOthers(salt);
        uint256 amount = _sizeAttacker(meme, lambdaBps);
        uint160 sqrt0 = _sqrtPriceOf(meme);
        (, int24 refTick) = t.hook.referencePrice(_poolId(meme));
        uint160 p0 = TickMath.getSqrtPriceAtTick(refTick);

        uint256 snap = vm.snapshotState();
        uint256 pos = _activate(meme, alice, amount, 0, 0);
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        _exitAs(alice, pos);
        uint256 honest = _wealth(meme, p0);
        vm.revertToState(snap);

        int24[2] memory gaps = [int24(500), int24(-500)];
        for (uint256 i; i < 2; ++i) {
            // one tick further: refused
            snap = vm.snapshotState();
            _moveTo(meme, _sqrtInTick(refTick + gaps[i] + (gaps[i] > 0 ? int24(1) : int24(-1))));
            (uint256 q,) = t.vault.quoteRequired(meme, amount);
            vm.prank(alice);
            vm.expectPartialRevert(IPerkLPGrantVault.PriceUnstable.selector);
            t.vault.activateGrant(meme, amount, 0, 0, q + q / 100 + 1, 0);
            vm.revertToState(snap);

            snap = vm.snapshotState();
            _moveTo(meme, _sqrtInTick(refTick + gaps[i]));
            (int24 spot, int24 ref) = t.hook.referencePrice(_poolId(meme));
            assertEq(int256(spot) - int256(ref), int256(gaps[i]), "exactly at the edge of the band");
            pos = _activate(meme, alice, amount, 0, 0);
            IPerkLPGrantVault.GrantPosition memory p = t.vault.position(pos);
            assertGe(p.protocolShareWad, _refShare(meme, p, refTick), "g never below the reference-valued share");
            uint256 lambda = Math.mulDiv(p.liquidity, WAD, StateLibrary.getLiquidity(manager, _poolId(meme)));
            _moveTo(meme, sqrt0); // trade the pool back in the same block
            vm.warp(vm.getBlockTimestamp() + 1 days + 1);
            _exitAs(alice, pos);
            int256 pnl = _signed(_wealth(meme, p0)) - _signed(honest);
            emit log_named_int("gap ticks", gaps[i]);
            emit log_named_uint("  lambda (wad)", lambda);
            emit log_named_uint("  g (wad)", p.protocolShareWad);
            emit log_named_int("  attacker P&L vs honest (quote wei at P0)", pnl);
            assertLe(pnl, 0, "the activation self-sandwich does not pay");
            vm.revertToState(snap);
        }
    }

    // -------------------------------------------------------------------------
    // 5. A third party sandwiching a victim's activation
    // -------------------------------------------------------------------------

    /// @dev The swapper front-runs alice's activation by moving the pool up to 500 ticks either way inside the band,
    ///      then trades it back. alice's quoteMax allows 1% slippage. Either the activation reverts (quote above her
    ///      maximum, or price outside the band) and she loses nothing, or her loss against an unsandwiched activation,
    ///      measured at her exit, is at most her slippage allowance. Her g is never below the reference-valued g.
    function test_activateGrant_thirdPartySandwich_victimLossBoundedBySlippage() public {
        address meme = _campaignWithOthers(keccak256("victim"));
        uint256 amount = 20_000_000 ether;
        uint160 sqrt0 = _sqrtPriceOf(meme);
        (, int24 refTick) = t.hook.referencePrice(_poolId(meme));
        uint160 p0 = TickMath.getSqrtPriceAtTick(refTick);
        (uint256 need,) = t.vault.quoteRequired(meme, amount);
        uint256 slip = need / 100;

        uint256 snap = vm.snapshotState();
        uint256 pos = _victimActivates(meme, amount, need + slip);
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        _exitAs(alice, pos);
        uint256 honest = _victimWealth(meme, p0);
        vm.revertToState(snap);

        int24[8] memory moves = [int24(50), 99, 101, 500, -50, -99, -300, -500];
        for (uint256 i; i < moves.length; ++i) {
            snap = vm.snapshotState();
            uint256 before = _victimWealth(meme, p0);
            _moveTo(meme, _sqrtInTick(refTick + moves[i])); // front-run
            vm.prank(alice);
            try t.vault.activateGrant(meme, amount, 0, 0, need + slip, 0) returns (uint256 id) {
                IPerkLPGrantVault.GrantPosition memory p = t.vault.position(id);
                assertGe(p.protocolShareWad, _refShare(meme, p, refTick), "g not below the reference-valued g");
                _moveTo(meme, sqrt0); // back-run
                vm.warp(vm.getBlockTimestamp() + 1 days + 1);
                _exitAs(alice, id);
                int256 loss = _signed(honest) - _signed(_victimWealth(meme, p0));
                emit log_named_int("front-run ticks", moves[i]);
                emit log_named_uint("  victim g (wad)", p.protocolShareWad);
                emit log_named_int("  victim loss vs unsandwiched (quote wei at P0)", loss);
                emit log_named_uint("  slippage allowance", slip);
                assertLe(loss, _signed(slip), "loss bounded by the quoteMax slippage");
            } catch (bytes memory err) {
                bytes4 sel = bytes4(err);
                assertTrue(
                    sel == IPerkLPGrantVault.QuoteExceedsMax.selector
                        || sel == IPerkLPGrantVault.PriceUnstable.selector,
                    "refused for price only"
                );
                assertEq(_victimWealth(meme, p0), before, "a refused activation costs nothing");
                emit log_named_int("front-run ticks (refused)", moves[i]);
            }
            vm.revertToState(snap);
        }
    }

    function _victimActivates(address meme, uint256 amount, uint256 quoteMax) internal returns (uint256) {
        vm.prank(alice);
        return t.vault.activateGrant(meme, amount, 0, 0, quoteMax, 0);
    }

    function _victimWealth(address meme, uint160 sqrtP) internal view returns (uint256) {
        return t.quoteToken.balanceOf(alice) + _memeValueInQuoteAt(meme, IERC20(meme).balanceOf(alice), sqrtP);
    }

    // -------------------------------------------------------------------------
    // 6. Honest exits during organic moves, reference stale
    // -------------------------------------------------------------------------

    /// @dev The market doubles or halves and alice exits in the same block, before the reference has moved. The
    ///      settlement is the reference-valued formula, computed here independently. With g ~ 0.5 and the reference
    ///      at P0, an exit after an organic r-fold move pays alice (1 - g)(D sqrt r + G P0 / sqrt r):
    ///        2x:   all in quote; the treasury receives quoteOut minus that (the quote the move brought in beyond
    ///              alice's share), and all the meme is burned. Against a caught-up reference alice receives less
    ///              quote now (D(sqrt2 + 1/sqrt2)/2 ~ 1.061 D instead of sqrt2 D ~ 1.414 D): the difference goes to
    ///              the treasury.
    ///        0.5x: all the quote plus meme at P0 for the rest; the burn is smaller than against a caught-up
    ///              reference: meme the protocol would have burned goes to alice instead.
    ///      Waiting for the reference (at 8 ticks per second, ~15 minutes for 2x) settles at the market price.
    function test_exitGrantPosition_organicMove_staleReference_matchesFormula() public {
        address meme = _campaignWithOthers(keccak256("organic"));
        Scene memory s;
        s.meme = meme;
        s.pos = _activate(meme, alice, 2_000_000 ether, 0, 0);
        _begin(s);
        IPerkLPGrantVault.GrantPosition memory p = t.vault.position(s.pos);

        uint256[2] memory moves = [SQRT_2, SQRT_0_5];
        for (uint256 i; i < 2; ++i) {
            uint256 snap = vm.snapshotState();
            _moveTo(meme, _targetSqrt(meme, s.p0, moves[i])); // a third party's genuine trade
            (, int24 refTick) = t.hook.referencePrice(_poolId(meme));
            assertEq(refTick, s.refTick, "reference stale");
            Exit memory expected = _formula(meme, p, s.p0);
            (uint256 memeOut, uint256 quoteOut) = _principalNow(meme, p.liquidity);

            uint256 snap2 = vm.snapshotState();
            Exit memory e = _exitAs(alice, s.pos);
            assertEq(e.toUser, expected.toUser, "quote to user = formula");
            assertEq(e.memeToUser, expected.memeToUser, "meme to user = formula");
            assertEq(e.toTreasury, expected.toTreasury, "quote to treasury = formula");
            assertEq(e.burned, expected.burned, "meme burned = formula");
            assertEq(e.toUser + e.toTreasury, quoteOut);
            assertEq(e.memeToUser + e.burned, memeOut);
            uint256 a = _realSqrtR(meme, p.entrySqrtPriceX96, _sqrtPriceOf(meme));
            // closed form: (1 - g)(D sqrt r + G P0 / sqrt r), r measured from the entry price
            uint256 closed = Math.mulDiv(
                Math.mulDiv(p.quoteDeposited, a, WAD)
                    + Math.mulDiv(_memeValueInQuoteAt(meme, p.grantMemeAmount, s.p0), WAD, a),
                WAD - p.protocolShareWad,
                WAD
            );
            assertApproxEqRel(e.toUser + _memeValueInQuoteAt(meme, e.memeToUser, s.p0), closed, 1e14);
            if (a > WAD) {
                assertEq(e.memeToUser, 0, "2x: paid in quote only");
                assertEq(e.burned, memeOut, "2x: all meme burned");
                assertGt(e.toTreasury, 0, "2x: quote beyond the user's share to the treasury");
            } else {
                assertEq(e.toTreasury, 0, "0.5x: all quote to the user first");
                assertGt(e.memeToUser, 0, "0.5x: the rest in meme at the reference");
            }
            vm.revertToState(snap2);

            // the same exit once the reference has caught up with the market
            vm.warp(vm.getBlockTimestamp() + 1 hours);
            (int24 spotTick, int24 caughtUp) = t.hook.referencePrice(_poolId(meme));
            assertEq(caughtUp, spotTick);
            Exit memory late = _exitAs(alice, s.pos);
            emit log_named_uint(a > WAD ? "organic 2x, sqrt(r) wad" : "organic 0.5x, sqrt(r) wad", a);
            emit log_named_uint("  stale ref: quote to user", e.toUser);
            emit log_named_uint("  stale ref: meme to user", e.memeToUser);
            emit log_named_uint("  stale ref: quote to treasury", e.toTreasury);
            emit log_named_uint("  stale ref: meme burned", e.burned);
            emit log_named_uint("  caught up: quote to user", late.toUser);
            emit log_named_uint("  caught up: meme to user", late.memeToUser);
            emit log_named_uint("  caught up: quote to treasury", late.toTreasury);
            emit log_named_uint("  caught up: meme burned", late.burned);
            if (a > WAD) {
                assertGt(e.toTreasury, late.toTreasury, "2x, stale: more quote to the treasury than once caught up");
            } else {
                assertLt(e.burned, late.burned, "0.5x, stale: less meme burned than once caught up");
            }
            vm.revertToState(snap);
        }
    }

    /// @dev The settlement formula at reference sqrt price `ref`, computed independently of the vault.
    function _formula(address meme, IPerkLPGrantVault.GrantPosition memory p, uint160 ref)
        internal
        view
        returns (Exit memory x)
    {
        (uint256 memeOut, uint256 quoteOut) = _principalNow(meme, p.liquidity);
        uint256 v = quoteOut + _memeValueInQuoteAt(meme, memeOut, ref);
        uint256 entitled = Math.mulDiv(v, WAD - p.protocolShareWad, WAD);
        x.toUser = Math.min(quoteOut, entitled);
        if (entitled > x.toUser) x.memeToUser = Math.min(memeOut, _quoteToMemeAt(meme, entitled - x.toUser, ref));
        x.toTreasury = quoteOut - x.toUser;
        x.burned = memeOut - x.memeToUser;
    }

    // -------------------------------------------------------------------------
    // 9. Sybil ring
    // -------------------------------------------------------------------------

    /// @dev A referral chain alice <- bob <- carol <- dave, all with base allocations and boost caps. Everything the
    ///      ring can earn beyond its base (invitee boosts plus inviter credits) stays within 20% of the ring's base;
    ///      activating boosts and credits earns nothing further; N minimum-size base activations earn no more boost or
    ///      credit than one activation of the same total.
    function test_sybilRing_extraBoundedAndNoCompounding() public {
        uint256 base = 1_000_000 ether;
        vm.prank(bob);
        t.referral.bindInviter(alice);
        vm.prank(carol);
        t.referral.bindInviter(bob);
        vm.prank(dave);
        t.referral.bindInviter(carol);
        address[4] memory ring = [alice, bob, carol, dave];
        tree = new bytes32[](4);
        for (uint256 i; i < 4; ++i) {
            tree[i] = MerkleTree.leaf(ring[i], base, i == 0 ? 0 : base / 10);
        }
        address meme = _graduated(t.erc20Quote, keccak256("sybil"));
        _proposeAndActivateRoot(meme, MerkleTree.root(tree), 4 * base, (3 * base) / 10);
        for (uint256 i; i < 4; ++i) {
            t.vault
                .registerAllocation(meme, _leafStruct(ring[i], base, i == 0 ? 0 : base / 10), MerkleTree.proof(tree, i));
        }

        // N minimum-size base activations vs one activation of the same total, odd-sized so rounding bites
        uint256 unit = 1 ether + 7;
        uint256 n = 10;
        uint256 snap = vm.snapshotState();
        _activate(meme, dave, unit * n, 0, 0);
        uint256 oneBoost = t.vault.allocation(meme, dave).boostEarned;
        uint256 oneCredit = t.vault.allocation(meme, carol).inviterCreditEarned;
        vm.revertToState(snap);
        for (uint256 i; i < n; ++i) {
            _activate(meme, dave, unit, 0, 0);
        }
        assertLe(t.vault.allocation(meme, dave).boostEarned, oneBoost, "splitting earns no more boost");
        assertLe(t.vault.allocation(meme, carol).inviterCreditEarned, oneCredit, "splitting earns no more credit");
        vm.revertToState(snap);

        // everyone activates all base, then every boost and credit they earned
        for (uint256 i; i < 4; ++i) {
            (uint256 b,,) = t.vault.grantBreakdown(meme, ring[i]);
            _activate(meme, ring[i], b, 0, 0);
        }
        uint256[4] memory boostBefore;
        uint256[4] memory creditBefore;
        for (uint256 i; i < 4; ++i) {
            (, uint256 boost, uint256 credit) = t.vault.grantBreakdown(meme, ring[i]);
            boostBefore[i] = t.vault.allocation(meme, ring[i]).boostEarned;
            creditBefore[i] = t.vault.allocation(meme, ring[i]).inviterCreditEarned;
            if (boost + credit >= 1 ether) _activate(meme, ring[i], 0, boost, credit);
        }
        uint256 extra;
        for (uint256 i; i < 4; ++i) {
            IPerkLPGrantVault.Allocation memory a = t.vault.allocation(meme, ring[i]);
            assertEq(a.boostEarned, boostBefore[i], "boost activations earn no boost");
            assertEq(a.inviterCreditEarned, creditBefore[i], "boost and credit activations earn no credit");
            assertLe(a.boostEarned, Math.min(a.inviteeBoost, a.baseActivated / 10));
            assertLe(a.inviterCreditEarned, a.baseAllocation / 2);
            extra += a.boostEarned + a.inviterCreditEarned;
        }
        emit log_named_uint("ring extra / ring base (bps)", (extra * 10_000) / (4 * base));
        assertLe(extra, (4 * base) / 5, "the ring's extra is at most 20% of its base");
    }

    // -------------------------------------------------------------------------
    // 14. InitialLpLocker: a foreign NFT does not block the official ones
    // -------------------------------------------------------------------------

    /// @dev Anyone can send the locker a PositionManager NFT of some other pool. Collecting it reverts (no Perk launch
    ///      behind it), and collecting the launch's own locked position still pays its dev.
    function test_initialLpLocker_foreignNft_doesNotBlockOfficialCollection() public {
        address meme = _graduated(t.erc20Quote, keccak256("locker-foreign"));
        IPerkGraduationManager.Graduation memory g = t.graduation.graduationOf(meme);
        uint256 foreignId = _mintForeignPosition();
        IERC721(address(t.positionManager)).safeTransferFrom(address(this), address(t.locker), foreignId);
        assertEq(IERC721(address(t.positionManager)).ownerOf(foreignId), address(t.locker));
        vm.expectRevert();
        t.locker.collectFees(foreignId);

        _arm(meme);
        _swap(g.key, _quoteIs0(meme), 5 ether, 0);
        _sellMeme(g.key, _quoteIs0(meme), meme, 5_000_000 ether);
        address dev = t.feeRouter.launchFees(meme).dev;
        uint256 devQuote = t.quoteToken.balanceOf(dev);
        uint256 devMeme = IERC20(meme).balanceOf(dev);
        t.locker.collectFees(g.positionTokenId);
        assertGt(t.quoteToken.balanceOf(dev), devQuote, "quote fees reach the dev");
        assertGt(IERC20(meme).balanceOf(dev), devMeme, "meme fees reach the dev");
    }

    /// @dev A position in a hookless pool of two plain tokens, minted through the same PositionManager.
    function _mintForeignPosition() internal returns (uint256 tokenId) {
        MockERC20 x = new MockERC20("X", "X", 18);
        MockERC20 y = new MockERC20("Y", "Y", 18);
        (MockERC20 a, MockERC20 b) = address(x) < address(y) ? (x, y) : (y, x);
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(a)),
            currency1: Currency.wrap(address(b)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
        manager.initialize(key, SQRT_PRICE_1_1);
        MockERC20[2] memory tokens = [a, b];
        for (uint256 i; i < 2; ++i) {
            tokens[i].mint(address(this), 1000 ether);
            tokens[i].approve(address(t.permit2), type(uint256).max);
            t.permit2.approve(address(tokens[i]), address(t.positionManager), type(uint160).max, type(uint48).max);
        }
        tokenId = t.positionManager.nextTokenId();
        bytes memory actions = abi.encodePacked(_byte(Actions.MINT_POSITION), _byte(Actions.SETTLE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(
            key, int24(-600), int24(600), uint256(1e18), type(uint128).max, type(uint128).max, address(this), bytes("")
        );
        params[1] = abi.encode(key.currency0, key.currency1);
        t.positionManager.modifyLiquidities(abi.encode(actions, params), vm.getBlockTimestamp());
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}

/// @dev Attacks by a contract beneficiary on a native-quote campaign: callbacks from the vault's native payments
///      (the activation refund, the exit payout) used to move the pool or re-enter the vault.
contract LPGrantVaultV14CallbackAttacksTest is V14AttackBase {
    using PoolIdLibrary for PoolKey;

    uint256 internal constant ATTACKER_GRANT = 50_000_000 ether;

    address internal meme;
    CallbackBeneficiary internal attacker;

    function setUp() public {
        _setUpPerk();
        meme = _graduated(t.nativeQuote, keccak256("callback"));
        key = t.graduation.graduationOf(meme).key;
        attacker = new CallbackBeneficiary(t.vault, swapRouter, IPoolManager(address(manager)), key, meme);
        tree = new bytes32[](2);
        tree[0] = MerkleTree.leaf(address(attacker), ATTACKER_GRANT, 0);
        tree[1] = MerkleTree.leaf(address(0xdead), 0, 0);
        _proposeAndActivateRoot(meme, MerkleTree.root(tree), ATTACKER_GRANT, 0);
        t.vault.registerAllocation(meme, _leafStruct(address(attacker), ATTACKER_GRANT, 0), MerkleTree.proof(tree, 0));
        uint256 inventory = IERC20(meme).balanceOf(buyer);
        vm.prank(buyer);
        IERC20(meme).transfer(address(attacker), inventory);
        vm.deal(address(attacker), 1000 ether);
    }

    // -------------------------------------------------------------------------
    // 1. Re-entrant g: the activation refund callback
    // -------------------------------------------------------------------------

    /// @dev quoteMax = need + 1 wei, so the vault refunds 1 wei and the attacker's receive() runs last. It crashes or
    ///      pumps the meme tenfold, the attacker trades the pool back in the same block and exits later. g and the
    ///      entry price are the ones read before the callback, and the attacker's P&L against an honest activation and
    ///      exit is not positive.
    function test_activateGrant_refundCallbackSwapsTenfold_gFromPreCallbackPrices_noProfit() public {
        uint160 sqrtBefore = _sqrtPriceOf(meme);
        (, int24 refTick) = t.hook.referencePrice(_poolId(meme));
        uint160 p0 = TickMath.getSqrtPriceAtTick(refTick);
        (uint256 need,) = t.vault.quoteRequired(meme, ATTACKER_GRANT);

        uint256 snap = vm.snapshotState();
        uint256 pos = attacker.activate(ATTACKER_GRANT, need + 1);
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        attacker.exit(pos);
        uint256 honest = _attackerWealth(p0);
        uint64 honestG = t.vault.position(pos).protocolShareWad;
        vm.revertToState(snap);

        // meme is currency1 against native quote: a higher sqrt price is a cheaper meme
        uint160[2] memory targets =
            [uint160(Math.mulDiv(sqrtBefore, SQRT_10, WAD)), uint160(Math.mulDiv(sqrtBefore, WAD, SQRT_10))];
        for (uint256 i; i < 2; ++i) {
            snap = vm.snapshotState();
            attacker.arm(targets[i]);
            pos = attacker.activate(ATTACKER_GRANT, need + 1);
            assertFalse(attacker.armed(), "the refund reached the callback");
            assertEq(_sqrtPriceOf(meme), targets[i], "the callback moved the pool tenfold");
            IPerkLPGrantVault.GrantPosition memory p = t.vault.position(pos);
            assertEq(p.entrySqrtPriceX96, sqrtBefore, "entry price from before the callback");
            assertEq(p.protocolShareWad, _expectedShare(meme, p, sqrtBefore, refTick), "g from pre-callback prices");
            assertEq(p.protocolShareWad, honestG, "g as an honest activation's");

            attacker.swapTo(sqrtBefore); // trade the pool back in the same block
            vm.warp(vm.getBlockTimestamp() + 1 days + 1);
            attacker.exit(pos);
            int256 pnl = _signed(_attackerWealth(p0)) - _signed(honest);
            emit log_named_string("callback", i == 0 ? "meme crashed tenfold" : "meme pumped tenfold");
            emit log_named_int("  attacker P&L vs honest (quote wei at P0)", pnl);
            assertLe(pnl, 0, "the refund callback does not pay");
            vm.revertToState(snap);
        }
    }

    // -------------------------------------------------------------------------
    // 13. Exit re-entrancy
    // -------------------------------------------------------------------------

    /// @dev The exit pays the beneficiary last, so a receive() that swaps (and tries to re-enter the vault) during the
    ///      exit's native payout changes nothing: the settlement equals an exit with no swap, the re-entry is refused
    ///      by the guard, and every balance afterwards equals exiting first and making the same swap afterwards.
    function test_exitGrantPosition_swapFromReceiveDuringPayout_changesNothing() public {
        (uint256 need,) = t.vault.quoteRequired(meme, ATTACKER_GRANT);
        uint256 pos = attacker.activate(ATTACKER_GRANT, need + 1);
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        vm.roll(vm.getBlockNumber() + 1);
        uint160 sqrt0 = _sqrtPriceOf(meme);
        uint160[2] memory targets = [uint160(Math.mulDiv(sqrt0, SQRT_2, WAD)), uint160(Math.mulDiv(sqrt0, WAD, SQRT_2))];

        for (uint256 i; i < 2; ++i) {
            // exit, then the same swap afterwards
            uint256 snap = vm.snapshotState();
            Exit memory first = _attackerExit(pos);
            attacker.swapTo(targets[i]);
            uint256[5] memory after_ = _balances();
            vm.revertToState(snap);

            // the swap and a re-entry attempt from receive() while the exit pays out
            snap = vm.snapshotState();
            attacker.arm(targets[i]);
            attacker.armReentry(pos);
            Exit memory during = _attackerExit(pos);
            assertFalse(attacker.armed(), "the payout reached the callback");
            assertTrue(attacker.reentryReverted(), "the re-entry was refused");
            assertEq(attacker.reentryError(), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
            assertEq(during.toUser, first.toUser);
            assertEq(during.memeToUser, first.memeToUser);
            assertEq(during.toTreasury, first.toTreasury);
            assertEq(during.burned, first.burned);
            uint256[5] memory got = _balances();
            for (uint256 j; j < 5; ++j) {
                assertEq(got[j], after_[j], "same end state as swapping after the exit");
            }
            vm.revertToState(snap);
        }
    }

    function _attackerExit(uint256 pos) internal returns (Exit memory e) {
        (e.toUser, e.memeToUser, e.toTreasury, e.burned) = attacker.exit(pos);
    }

    /// @dev attacker native, attacker meme, treasury native, meme supply, pool price.
    function _balances() internal view returns (uint256[5] memory b) {
        b[0] = address(attacker).balance;
        b[1] = IERC20(meme).balanceOf(address(attacker));
        b[2] = address(t.treasury).balance;
        b[3] = IERC20(meme).totalSupply();
        b[4] = _sqrtPriceOf(meme);
    }

    function _attackerWealth(uint160 sqrtP) internal view returns (uint256) {
        return address(attacker).balance + _memeValueInQuoteAt(meme, IERC20(meme).balanceOf(address(attacker)), sqrtP);
    }
}

/// @dev A contract beneficiary on a native-quote pool (native is currency0, meme currency1). Its receive() can, once,
///      move the pool to a target price and try to re-enter the vault.
contract CallbackBeneficiary {
    using PoolIdLibrary for PoolKey;

    IPerkLPGrantVault internal immutable VAULT;
    PoolSwapTest internal immutable ROUTER;
    IPoolManager internal immutable MANAGER;
    address internal immutable MEME;
    PoolKey internal key;
    uint160 internal target;
    uint256 internal reentryPos;
    bool public armed;
    bool public reentryReverted;
    bytes4 public reentryError;

    constructor(
        IPerkLPGrantVault vault_,
        PoolSwapTest router_,
        IPoolManager manager_,
        PoolKey memory key_,
        address meme_
    ) {
        VAULT = vault_;
        ROUTER = router_;
        MANAGER = manager_;
        key = key_;
        MEME = meme_;
        IERC20(meme_).approve(address(router_), type(uint256).max);
    }

    function arm(uint160 target_) external {
        target = target_;
        armed = true;
    }

    function armReentry(uint256 pos) external {
        reentryPos = pos;
    }

    function activate(uint256 base, uint256 quoteMax) external returns (uint256) {
        return VAULT.activateGrant{value: quoteMax}(MEME, base, 0, 0, quoteMax, 0);
    }

    function exit(uint256 pos) external returns (uint256, uint256, uint256, uint256) {
        return VAULT.exitGrantPosition(pos, 0, 0);
    }

    function swapTo(uint160 limit) external {
        _swapTo(limit);
    }

    receive() external payable {
        if (reentryPos != 0) {
            uint256 pos = reentryPos;
            reentryPos = 0;
            try VAULT.collectGrantFees(pos) {}
            catch (bytes memory err) {
                reentryReverted = true;
                reentryError = bytes4(err);
            }
        }
        if (!armed) return;
        armed = false;
        _swapTo(target);
    }

    /// @dev Moves the pool to `limit`: buys meme with native (exact output, price-limited) to push the sqrt price
    ///      down, sells all its meme (exact input, price-limited) to push it up.
    function _swapTo(uint160 limit) internal {
        (uint160 cur,,,) = StateLibrary.getSlot0(MANAGER, key.toId());
        if (limit == cur) return;
        if (limit < cur) {
            ROUTER.swap{value: address(this).balance}(
                key,
                SwapParams({zeroForOne: true, amountSpecified: int256(1e30), sqrtPriceLimitX96: limit}),
                PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
                bytes("")
            );
        } else {
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
}

/// @dev Rounding at dust sizes with a 6-decimal quote, where one raw quote unit is a large part of a small position.
contract LPGrantVaultV14DustTest is V14AttackBase {
    using PoolIdLibrary for PoolKey;

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
        address[3] memory who = [creator, buyer, alice];
        for (uint256 i; i < who.length; ++i) {
            stock.mint(who[i], 1_000_000e6);
            vm.startPrank(who[i]);
            stock.approve(address(t.factory), type(uint256).max);
            stock.approve(address(t.curve), type(uint256).max);
            stock.approve(address(t.vault), type(uint256).max);
            vm.stopPrank();
        }
    }

    /// @dev Grant sizes from minActivation up, quoteMax exactly the quote required. The vault floors the grant
    ///      meme's quote value before rounding the share up, so at dust sizes g can sit a little below the exact
    ///      share; the value that moves to the beneficiary that way is under one raw quote unit, and the round trip
    ///      (activate, exit later at an unchanged price) never returns more than was deposited. minActivation holds.
    function test_activateGrant_sixDecimalQuote_dustRoundingNeverPaysTheUser() public {
        address meme = _createLaunch(stockTemplate, stockQuote, keccak256("dust"));
        vm.prank(buyer);
        t.curve.buy(meme, 100e6, 0, buyer);
        t.graduation.graduate(meme);
        IPerkLPGrantVault.GrantLeaf memory leaf = _leafStruct(alice, 10_000_000 ether, 0);
        _proposeAndActivateRoot(meme, t.vault.leafHash(leaf), 10_000_000 ether, 0);
        t.vault.registerAllocation(meme, leaf, new bytes32[](0));

        uint256 minAct = t.vault.config().minActivation;
        vm.prank(alice);
        vm.expectRevert(IPerkLPGrantVault.BelowMinimumActivation.selector);
        t.vault.activateGrant(meme, minAct - 1, 0, 0, 1e6, 0);

        (, int24 refTick) = t.hook.referencePrice(_poolId(meme));
        uint160 p0 = TickMath.getSqrtPriceAtTick(refTick);
        uint160 spot = _sqrtPriceOf(meme);
        uint256[5] memory sizes = [minAct, 7 ether + 3, 1000 ether, 123_457 ether + 11, 5_000_000 ether];
        for (uint256 i; i < sizes.length; ++i) {
            uint256 snap = vm.snapshotState();
            (uint256 need,) = t.vault.quoteRequired(meme, sizes[i]);
            uint256 before = stock.balanceOf(alice) + _memeValueInQuoteAt(meme, IERC20(meme).balanceOf(alice), p0);
            vm.prank(alice);
            uint256 pos = t.vault.activateGrant(meme, sizes[i], 0, 0, need, 0);
            IPerkLPGrantVault.GrantPosition memory p = t.vault.position(pos);

            // the exact share is at most the one with the meme value rounded up, at the larger of spot and reference
            uint256 mv =
                Math.max(_memeValueCeil(meme, p.grantMemeAmount, spot), _memeValueCeil(meme, p.grantMemeAmount, p0));
            uint256 exactHi = Math.mulDiv(mv, WAD, mv + p.quoteDeposited, Math.Rounding.Ceil);
            uint256 deficit = exactHi > p.protocolShareWad ? exactHi - p.protocolShareWad : 0;
            uint256 shifted = Math.mulDiv(deficit, mv + p.quoteDeposited, WAD, Math.Rounding.Ceil);

            vm.warp(vm.getBlockTimestamp() + 1 days + 1);
            _exitAs(alice, pos);
            uint256 afterExit = stock.balanceOf(alice) + _memeValueInQuoteAt(meme, IERC20(meme).balanceOf(alice), p0);
            int256 roundTrip = _signed(afterExit) - _signed(before);
            emit log_named_uint("grant meme", sizes[i]);
            emit log_named_uint("  quote deposited (raw)", p.quoteDeposited);
            emit log_named_uint("  g (wad)", p.protocolShareWad);
            emit log_named_uint("  exact g upper bound (wad)", exactHi);
            emit log_named_uint("  value g rounding can shift to the user (raw quote)", shifted);
            emit log_named_int("  round trip (raw quote at P0)", roundTrip);
            assertLe(shifted, 1, "rounding shifts at most one raw quote unit to the beneficiary");
            assertLe(roundTrip, 0, "the round trip never pays the beneficiary");
            vm.revertToState(snap);
        }
    }

    function _memeValueCeil(address meme, uint256 amount, uint160 sqrtP) internal view returns (uint256) {
        uint256 q96 = 1 << 96;
        if (_memeIs0(meme)) {
            return Math.mulDiv(Math.mulDiv(amount, sqrtP, q96, Math.Rounding.Ceil), sqrtP, q96, Math.Rounding.Ceil);
        }
        return Math.mulDiv(Math.mulDiv(amount, q96, sqrtP, Math.Rounding.Ceil), q96, sqrtP, Math.Rounding.Ceil);
    }
}

/// @dev Exact accounting invariants under random activations, fee collections, exits, trading and time: the vault's
///      meme is exactly the campaign's remaining inventory (no tolerance), positions add up to totalActivated, and
///      the vault never keeps quote.
/// forge-config: default.invariant.runs = 16
/// forge-config: default.invariant.depth = 12
/// forge-config: default.invariant.fail_on_revert = false
contract LPGrantVaultV14InvariantTest is GrantTestBase {
    GrantHandler internal handler;
    address internal meme;

    function setUp() public {
        _setUpPerk();
        _bindBobToAlice();
        meme = _activeDefault(keccak256("v14-invariant"));
        _registerDefault(meme);
        vm.prank(buyer);
        IERC20(meme).transfer(swapper, 30_000_000 ether);
        address[3] memory actors = [alice, bob, carol];
        handler = new GrantHandler(t.vault, meme, actors, swapRouter, swapper, IERC20(meme));
        targetContract(address(handler));
        bytes4[] memory sels = new bytes4[](6);
        sels[0] = GrantHandler.activate.selector;
        sels[1] = GrantHandler.collect.selector;
        sels[2] = GrantHandler.exitPos.selector;
        sels[3] = GrantHandler.warpTime.selector;
        sels[4] = GrantHandler.buy.selector;
        sels[5] = GrantHandler.sell.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
    }

    function invariant_vaultMemeIsExactlyTheInventory() public view {
        IPerkLPGrantVault.Campaign memory c = t.vault.campaign(meme);
        assertEq(IERC20(meme).balanceOf(address(t.vault)), c.reserve - c.totalActivated, "vault meme = inventory");
        assertEq(t.vault.inventoryRemaining(meme), c.reserve - c.totalActivated);
        uint256 sum;
        address[3] memory who = [alice, bob, carol];
        for (uint256 a; a < 3; ++a) {
            uint256[] memory ids = t.vault.positionsOf(who[a]);
            for (uint256 i; i < ids.length; ++i) {
                sum += t.vault.position(ids[i]).grantMemeAmount;
            }
        }
        assertEq(sum, c.totalActivated, "positions add up to totalActivated");
        assertLe(c.totalActivated, c.reserve);
        assertEq(t.quoteToken.balanceOf(address(t.vault)), 0, "no quote kept");
    }
}
// forge-lint: disable-end(environment-read-across-mutation)
