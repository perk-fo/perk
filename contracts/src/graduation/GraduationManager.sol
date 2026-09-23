// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "v4-core/src/types/Currency.sol";
import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {Permit2Forwarder} from "v4-periphery/src/base/Permit2Forwarder.sol";
import {Actions} from "v4-periphery/src/libraries/Actions.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IPerkGraduationManager} from "../interfaces/IPerkGraduationManager.sol";
import {IPerkBondingCurve} from "../interfaces/IPerkBondingCurve.sol";
import {IPerkFeeRouter} from "../interfaces/IPerkFeeRouter.sol";
import {IPerkComposableHook} from "../interfaces/IPerkComposableHook.sol";
import {IPerkLaunchFactory} from "../interfaces/IPerkLaunchFactory.sol";
import {IPerkLPGrantVault} from "../interfaces/IPerkLPGrantVault.sol";
import {IPerkTemplateRegistry} from "../interfaces/IPerkTemplateRegistry.sol";
import {IPerkCommunityTreasury} from "../interfaces/IPerkCommunityTreasury.sol";
import {PerkMemeToken} from "../token/PerkMemeToken.sol";
import {PerkConstants} from "../libraries/PerkConstants.sol";
import {PerkTypes} from "../libraries/PerkTypes.sol";

/// @title GraduationManager
/// @notice Two-phase, resumable graduation: seed a v4 pool at the curve's final price and lock the LP NFT.
contract GraduationManager is IPerkGraduationManager, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using CurrencyLibrary for Currency;
    using PoolIdLibrary for PoolKey;

    /// @inheritdoc IPerkGraduationManager
    address public immutable override factory;
    /// @inheritdoc IPerkGraduationManager
    address public immutable override curve;
    /// @inheritdoc IPerkGraduationManager
    address public immutable override feeRouter;
    /// @inheritdoc IPerkGraduationManager
    address public immutable override poolManager;
    /// @inheritdoc IPerkGraduationManager
    address public immutable override positionManager;
    /// @inheritdoc IPerkGraduationManager
    address public immutable override initialLpLocker;

    address public immutable templateRegistry;
    IAllowanceTransfer internal immutable PERMIT2;

    /// @inheritdoc IPerkGraduationManager
    uint64 public immutable override rescueDelay;
    /// @dev A rescue can never be executed sooner than this after it is proposed, whatever the deployment says.
    uint64 internal constant MIN_RESCUE_DELAY = 1 hours;

    /// @inheritdoc IPerkGraduationManager
    address public override hook;

    mapping(address meme => Graduation) private _graduations;
    mapping(address token => bool) private _permit2Approved;

    /// @param owner_ Two-step Ownable owner, allowed to `wire` the hook once.
    /// @param factory_ Launch factory used to read records and set GRADUATED.
    /// @param curve_ Bonding curve that releases unsold meme + realQuote.
    /// @param feeRouter_ Fee router that releases the curve-stage LP reserve.
    /// @param poolManager_ Uniswap v4 PoolManager.
    /// @param positionManager_ Uniswap v4 PositionManager used to mint locked LP.
    /// @param templateRegistry_ Template registry (tick range, leftover policy, fees).
    /// @param initialLpLocker_ Recipient of the locked position NFTs.
    /// @param rescueDelay_ Delay between proposing and executing a rescue (at least MIN_RESCUE_DELAY).
    constructor(
        address owner_,
        address factory_,
        address curve_,
        address feeRouter_,
        address poolManager_,
        address positionManager_,
        address templateRegistry_,
        address initialLpLocker_,
        uint64 rescueDelay_
    ) Ownable(_nonZero(owner_)) {
        if (
            factory_ == address(0) || curve_ == address(0) || feeRouter_ == address(0) || poolManager_ == address(0)
                || positionManager_ == address(0) || templateRegistry_ == address(0) || initialLpLocker_ == address(0)
        ) {
            revert ZeroAddress();
        }
        factory = factory_;
        curve = curve_;
        feeRouter = feeRouter_;
        poolManager = poolManager_;
        positionManager = positionManager_;
        templateRegistry = templateRegistry_;
        initialLpLocker = initialLpLocker_;
        PERMIT2 = Permit2Forwarder(positionManager_).permit2();
        if (rescueDelay_ < MIN_RESCUE_DELAY) revert RescueDelayTooShort();
        rescueDelay = rescueDelay_;
    }

    /// @notice Accepts native quote transferred by the curve and fee router at FUNDED.
    receive() external payable {}

    /// @notice LP grant vault that receives `initCampaign` at graduation for grant-enabled launches. Set once.
    address public lpGrantVault;

    event VaultWired(address indexed lpGrantVault);

    /// @notice One-time wiring of the LPGrantVault (owner only).
    function wireVault(address lpGrantVault_) external onlyOwner {
        if (lpGrantVault != address(0)) revert AlreadyWired();
        if (lpGrantVault_ == address(0)) revert ZeroAddress();
        lpGrantVault = lpGrantVault_;
        emit VaultWired(lpGrantVault_);
    }

    /// @notice One-time hook wiring. Owner only. The hook is CREATE2-mined after this contract is deployed.
    /// @param hook_ Composable hook address (permission flags encoded).
    function wire(address hook_) external onlyOwner {
        if (hook != address(0)) revert AlreadyWired();
        if (hook_ == address(0)) revert ZeroAddress();
        hook = hook_;
    }

    /// @inheritdoc IPerkGraduationManager
    function graduate(address meme) external nonReentrant {
        if (IPerkLaunchFactory(factory).isPaused(PerkConstants.PAUSE_GRADUATION)) {
            revert IPerkLaunchFactory.Paused(PerkConstants.PAUSE_GRADUATION);
        }
        PerkTypes.LaunchRecord memory rec = IPerkLaunchFactory(factory).getLaunch(meme);
        if (rec.status != PerkTypes.LaunchStatus.GRADUATION_PENDING) revert NotGraduationPending();

        Graduation storage g = _graduations[meme];
        if (g.stage == Stage.DONE) revert AlreadyDone();

        // Each stage is an external self-call so a revert in stage N keeps stages < N
        // committed in this transaction (the catch does not rethrow). Happy path still
        // finishes every remaining stage in one `graduate` call.
        while (g.stage != Stage.DONE) {
            // forge-lint: disable-next-line(calls-loop)
            (bool ok, bytes memory reason) = address(this).call(abi.encodeCall(this.executeStage, (meme)));
            if (!ok) {
                // Swallowed so the earlier stages stay committed, but never silently: the transaction succeeds, and
                // without this nothing on chain says that it stopped short or why.
                // forge-lint: disable-next-line(reentrancy-events)
                emit GraduationStageFailed(meme, g.stage, reason);
                break;
            }
        }
        if (g.stage != Stage.DONE && g.stage == Stage.NONE) {
            // Stage NONE failed: nothing committed; bubble a revert so callers see it.
            this.executeStage(meme);
        }
    }

    /// @notice Executes the next graduation stage. Only callable by this contract via `graduate`.
    /// @param meme Launch token.
    function executeStage(address meme) external {
        if (msg.sender != address(this)) revert InvalidStage(_graduations[meme].stage);
        PerkTypes.LaunchRecord memory rec = IPerkLaunchFactory(factory).getLaunch(meme);
        PerkTypes.Template memory tmpl = IPerkTemplateRegistry(templateRegistry).getTemplate(rec.templateId);
        Graduation storage g = _graduations[meme];
        if (g.stage == Stage.NONE) _stageFunded(meme, g);
        else if (g.stage == Stage.FUNDED) _stagePoolInitialized(meme, rec, tmpl, g);
        else if (g.stage == Stage.POOL_INITIALIZED) _stageLiquidityAdded(meme, rec, tmpl, g);
        else if (g.stage == Stage.LIQUIDITY_ADDED) _stageDone(meme, rec, tmpl, g);
        else revert InvalidStage(g.stage);
    }

    /// @inheritdoc IPerkGraduationManager
    function graduationOf(address meme) external view returns (Graduation memory) {
        return _graduations[meme];
    }

    function _stageFunded(address meme, Graduation storage g) private {
        (uint256 m, uint256 q) = IPerkBondingCurve(curve).finalizeForGraduation(meme, address(this));
        q += IPerkFeeRouter(feeRouter).releaseLpReserve(meme, address(this));

        // Seed at the curve's final price expressed directly as the virtual reserve ratio. Going through priceX18
        // loses everything for low-decimal quotes (a 6-decimal quote against 1e27 meme rounds priceX18 to zero).
        IPerkBondingCurve.CurveState memory cs = IPerkBondingCurve(curve).curveState(meme);
        uint256 memeToPool = m;
        uint256 cap = Math.mulDiv(q, cs.virtualMeme, cs.virtualQuote);
        if (cap < m) memeToPool = cap;
        uint256 quoteToPool = Math.mulDiv(memeToPool, cs.virtualQuote, cs.virtualMeme);

        g.memeReceived = m;
        g.quoteReceived = q;
        g.memeToPool = memeToPool;
        g.quoteToPool = quoteToPool;
        g.memeLeftover = m - memeToPool;
        g.quoteLeftover = q - quoteToPool;
        g.quoteHeld = q;
        g.stage = Stage.FUNDED;
        // External pulls above are guarded by graduate's nonReentrant.
        // forge-lint: disable-next-line(reentrancy-events)
        emit GraduationStageAdvanced(meme, Stage.FUNDED);
    }

    function _stagePoolInitialized(
        address meme,
        PerkTypes.LaunchRecord memory rec,
        PerkTypes.Template memory tmpl,
        Graduation storage g
    ) private {
        PoolKey memory key = _poolKey(meme, rec.quote, tmpl);
        IPerkBondingCurve.CurveState memory cs = IPerkBondingCurve(curve).curveState(meme);
        uint160 sqrtPriceX96 = _sqrtPriceX96(cs.virtualQuote, cs.virtualMeme, rec.quote == key.currency0);
        _registerAndInit(key, rec, meme, sqrtPriceX96, tmpl.totalFeeBps, tmpl.feeSplit.lpBps);
        g.key = key;
        g.poolId = key.toId();
        g.sqrtPriceX96 = sqrtPriceX96;
        g.stage = Stage.POOL_INITIALIZED;
        // forge-lint: disable-next-line(reentrancy-events)
        emit GraduationStageAdvanced(meme, Stage.POOL_INITIALIZED);
    }

    function _poolKey(address meme, Currency quote, PerkTypes.Template memory tmpl)
        private
        view
        returns (PoolKey memory key)
    {
        Currency memeC = Currency.wrap(meme);
        if (quote < memeC) {
            key = PoolKey(quote, memeC, tmpl.pool.lpFee, tmpl.pool.tickSpacing, IHooks(hook));
        } else {
            key = PoolKey(memeC, quote, tmpl.pool.lpFee, tmpl.pool.tickSpacing, IHooks(hook));
        }
    }

    function _registerAndInit(
        PoolKey memory key,
        PerkTypes.LaunchRecord memory rec,
        address meme,
        uint160 sqrtPriceX96,
        uint24 totalFeeBps,
        uint16 lpBps
    ) private {
        // totalFeeBps is uint24 and the bps split is <= BPS, so the product fits uint24.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint24 hookFeeBps = uint24(Math.mulDiv(totalFeeBps, PerkConstants.BPS - lpBps, PerkConstants.BPS));
        IPerkComposableHook hook_ = IPerkComposableHook(hook);
        PoolId id = key.toId();
        if (!hook_.poolInfo(id).registered) {
            hook_.registerPool(key, rec.launchId, meme, rec.configHash, rec.moduleBitmap, hookFeeBps);
        }
        if (!hook_.poolInfo(id).initialized) {
            // forge-lint: disable-next-line(unused-return)
            IPoolManager(poolManager).initialize(key, sqrtPriceX96);
        }
    }

    function _stageLiquidityAdded(
        address meme,
        PerkTypes.LaunchRecord memory rec,
        PerkTypes.Template memory tmpl,
        Graduation storage g
    ) private {
        _approvePosm(g.key.currency0);
        _approvePosm(g.key.currency1);

        uint256 nextId = IPositionManager(positionManager).nextTokenId();
        uint128 liquidity = _mainLiquidity(g, tmpl, rec.quote == g.key.currency0);
        bool mintQuoteOnly;
        // Only this launch's own quote goes in. The manager's balance also holds whatever other launches have
        // parked between stages, and none of that is this launch's to spend or to be refunded.
        uint256 nativeValue = rec.quote.isAddressZero() ? g.quoteHeld : 0;
        bytes memory payload = _buildMintPayload(g, tmpl, rec.quote == g.key.currency0);
        mintQuoteOnly = g.quoteLeftover > 0 && _quoteOnlyLiq(g, tmpl, rec.quote == g.key.currency0) > 0;

        uint256 quoteBefore = rec.quote.balanceOfSelf();
        // Deadline is the current block; the modifier is `>` so equality is valid.
        // forge-lint: disable-next-line(block-timestamp)
        IPositionManager(positionManager).modifyLiquidities{value: nativeValue}(payload, block.timestamp);
        // checked: minting more than this launch holds would be spending another launch's funds, so it reverts
        g.quoteHeld -= quoteBefore - rec.quote.balanceOfSelf();

        g.positionTokenId = nextId;
        g.liquidity = liquidity;
        if (mintQuoteOnly) g.quoteOnlyPositionTokenId = nextId + 1;
        g.stage = Stage.LIQUIDITY_ADDED;
        // forge-lint: disable-next-line(reentrancy-events)
        emit GraduationStageAdvanced(meme, Stage.LIQUIDITY_ADDED);
    }

    function _mainLiquidity(Graduation storage g, PerkTypes.Template memory tmpl, bool quoteIs0)
        private
        view
        returns (uint128)
    {
        uint256 amount0 = quoteIs0 ? g.quoteToPool : g.memeToPool;
        uint256 amount1 = quoteIs0 ? g.memeToPool : g.quoteToPool;
        return LiquidityAmounts.getLiquidityForAmounts(
            g.sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(tmpl.pool.tickLower),
            TickMath.getSqrtPriceAtTick(tmpl.pool.tickUpper),
            amount0,
            amount1
        );
    }

    function _quoteOnlyLiq(Graduation storage g, PerkTypes.Template memory tmpl, bool quoteIs0)
        private
        view
        returns (uint128)
    {
        (bool mint,,, uint128 liq) = _quoteOnlyRange(g, tmpl, quoteIs0);
        return mint ? liq : 0;
    }

    function _buildMintPayload(Graduation storage g, PerkTypes.Template memory tmpl, bool quoteIs0)
        private
        view
        returns (bytes memory)
    {
        uint128 liquidity = _mainLiquidity(g, tmpl, quoteIs0);
        bytes memory mintMain = abi.encode(
            g.key,
            tmpl.pool.tickLower,
            tmpl.pool.tickUpper,
            uint256(liquidity),
            type(uint128).max,
            type(uint128).max,
            initialLpLocker,
            bytes("")
        );
        if (g.quoteLeftover == 0) {
            return _encodeSingleMint(g.key, mintMain);
        }
        (bool mintQuoteOnly, int24 quoteLower, int24 quoteUpper, uint128 quoteOnlyLiq) =
            _quoteOnlyRange(g, tmpl, quoteIs0);
        if (!mintQuoteOnly) {
            return _encodeSingleMint(g.key, mintMain);
        }
        return _encodeDoubleMint(g.key, mintMain, quoteLower, quoteUpper, quoteOnlyLiq);
    }

    function _actionByte(uint256 action) private pure returns (bytes1) {
        // Actions IDs are constants well below 256.
        // forge-lint: disable-next-line(unsafe-typecast)
        return bytes1(uint8(action));
    }

    function _encodeSingleMint(PoolKey memory key, bytes memory mintMain) private view returns (bytes memory) {
        bytes memory actions = abi.encodePacked(
            _actionByte(Actions.MINT_POSITION),
            _actionByte(Actions.SETTLE_PAIR),
            _actionByte(Actions.SWEEP),
            _actionByte(Actions.SWEEP)
        );
        bytes[] memory params = new bytes[](4);
        params[0] = mintMain;
        params[1] = abi.encode(key.currency0, key.currency1);
        params[2] = abi.encode(key.currency0, address(this));
        params[3] = abi.encode(key.currency1, address(this));
        return abi.encode(actions, params);
    }

    function _encodeDoubleMint(
        PoolKey memory key,
        bytes memory mintMain,
        int24 quoteLower,
        int24 quoteUpper,
        uint128 quoteOnlyLiq
    ) private view returns (bytes memory) {
        bytes memory actions = abi.encodePacked(
            _actionByte(Actions.MINT_POSITION),
            _actionByte(Actions.MINT_POSITION),
            _actionByte(Actions.SETTLE_PAIR),
            _actionByte(Actions.SWEEP),
            _actionByte(Actions.SWEEP)
        );
        bytes[] memory params = new bytes[](5);
        params[0] = mintMain;
        params[1] = abi.encode(
            key,
            quoteLower,
            quoteUpper,
            uint256(quoteOnlyLiq),
            type(uint128).max,
            type(uint128).max,
            initialLpLocker,
            bytes("")
        );
        params[2] = abi.encode(key.currency0, key.currency1);
        params[3] = abi.encode(key.currency0, address(this));
        params[4] = abi.encode(key.currency1, address(this));
        return abi.encode(actions, params);
    }

    function _stageDone(
        address meme,
        PerkTypes.LaunchRecord memory rec,
        PerkTypes.Template memory tmpl,
        Graduation storage g
    ) private {
        uint256 memeBurned = 0;
        uint256 quoteInRangeOrder = g.quoteLeftover;
        if (g.memeLeftover > 0) {
            if (tmpl.pool.leftoverPolicy == PerkTypes.LeftoverPolicy.RANGE_ORDER) {
                revert LeftoverPolicyNotImplemented();
            }
            PerkMemeToken(meme).burn(g.memeLeftover);
            memeBurned = g.memeLeftover;
        }
        // forge-lint: disable-next-line(reentrancy-events)
        emit LeftoverHandled(meme, memeBurned, quoteInRangeOrder);

        IPerkLaunchFactory(factory).setLaunchStatus(meme, PerkTypes.LaunchStatus.GRADUATED, g.poolId);
        g.stage = Stage.DONE;
        if (g.rescueExecutableAt != 0) {
            // it graduated during the rescue delay: the rescue no longer applies
            g.rescueExecutableAt = 0;
            // forge-lint: disable-next-line(reentrancy-events)
            emit RescueCancelled(meme);
        }
        if (tmpl.grant.enabled && lpGrantVault != address(0)) {
            IPerkLPGrantVault(lpGrantVault)
                .initCampaign(meme, g.key, !(rec.quote == g.key.currency0), tmpl.pool.tickLower, tmpl.pool.tickUpper);
        }
        // forge-lint: disable-next-line(reentrancy-events)
        emit LaunchGraduated(meme, rec.launchId, g.poolId, g.memeToPool, g.quoteToPool, g.liquidity);

        _sweepDust(meme, rec.quote, rec.launchId, g);
    }

    /// @dev The meme balance is this launch's alone. The quote balance is not: it is shared with every launch that
    ///      is between stages, so only what this launch still holds is swept.
    function _sweepDust(address meme, Currency quote, bytes32 launchId, Graduation storage g) private {
        uint256 memeDust = IERC20(meme).balanceOf(address(this));
        if (memeDust > 0) PerkMemeToken(meme).burn(memeDust);

        uint256 quoteDust = g.quoteHeld;
        if (quoteDust == 0) return;
        g.quoteHeld = 0;

        address treasury = IPerkLaunchFactory(factory).treasury();
        if (quote.isAddressZero()) {
            // Treasury address is the factory's immutable CommunityTreasury, not an arbitrary recipient.
            // forge-lint: disable-next-line(arbitrary-send-eth)
            IPerkCommunityTreasury(treasury).deposit{value: quoteDust}(quote, quoteDust, launchId);
        } else {
            IERC20(Currency.unwrap(quote)).forceApprove(treasury, quoteDust);
            IPerkCommunityTreasury(treasury).deposit(quote, quoteDust, launchId);
        }
    }

    // ---------------------------------------------------------------------
    // Rescue: a launch stuck before its liquidity was added
    // ---------------------------------------------------------------------

    /// @inheritdoc IPerkGraduationManager
    function proposeRescue(address meme) external onlyOwner {
        if (IPerkLaunchFactory(factory).getLaunch(meme).status != PerkTypes.LaunchStatus.GRADUATION_PENDING) {
            revert NotGraduationPending();
        }
        Graduation storage g = _graduations[meme];
        if (!_rescuable(g.stage)) revert NotRescuable(g.stage);
        if (g.rescueExecutableAt != 0) revert RescueAlreadyProposed();
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 at = uint64(block.timestamp) + rescueDelay;
        g.rescueExecutableAt = at;
        emit RescueProposed(meme, at);
    }

    /// @inheritdoc IPerkGraduationManager
    function cancelRescue(address meme) external onlyOwner {
        Graduation storage g = _graduations[meme];
        if (g.rescueExecutableAt == 0) revert RescueNotProposed();
        if (g.stage == Stage.REFUNDING) revert NotRescuable(g.stage);
        g.rescueExecutableAt = 0;
        emit RescueCancelled(meme);
    }

    /// @inheritdoc IPerkGraduationManager
    /// @dev Permissionless: the owner decided when proposing, the delay let everyone see it coming, and the money
    ///      can only go back to holders.
    function executeRescue(address meme) external nonReentrant {
        Graduation storage g = _graduations[meme];
        uint64 at = g.rescueExecutableAt;
        if (at == 0) revert RescueNotProposed();
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < at) revert RescueNotReady(at);
        if (IPerkLaunchFactory(factory).getLaunch(meme).status != PerkTypes.LaunchStatus.GRADUATION_PENDING) {
            revert NotGraduationPending();
        }
        if (!_rescuable(g.stage)) revert NotRescuable(g.stage);

        if (g.stage == Stage.NONE) {
            // the holders' money is still in the curve: take it out exactly as the FUNDED stage would
            (uint256 m, uint256 q) = IPerkBondingCurve(curve).finalizeForGraduation(meme, address(this));
            q += IPerkFeeRouter(feeRouter).releaseLpReserve(meme, address(this));
            g.memeReceived = m;
            g.quoteReceived = q;
            g.quoteHeld = q;
        }
        // No pool will be seeded, so this launch's unsold and reserved tokens have no purpose left. Burning them
        // also keeps them out of the supply that shares the refund.
        uint256 memeBurned = IERC20(meme).balanceOf(address(this));
        if (memeBurned > 0) PerkMemeToken(meme).burn(memeBurned);
        g.stage = Stage.REFUNDING;
        IPerkLaunchFactory(factory).setLaunchStatus(meme, PerkTypes.LaunchStatus.REFUNDING, PoolId.wrap(bytes32(0)));
        // forge-lint: disable-next-line(reentrancy-events)
        emit RescueExecuted(meme, g.quoteHeld, memeBurned);
    }

    /// @inheritdoc IPerkGraduationManager
    function redeem(address meme, uint256 amount) external nonReentrant returns (uint256 quoteOut) {
        Graduation storage g = _graduations[meme];
        if (g.stage != Stage.REFUNDING) revert NotRefunding();
        quoteOut = _redeemQuote(meme, g.quoteHeld, amount);
        if (quoteOut == 0) revert NothingToRedeem();
        g.quoteHeld -= quoteOut;
        IERC20(meme).safeTransferFrom(msg.sender, address(this), amount);
        PerkMemeToken(meme).burn(amount);
        emit Redeemed(meme, msg.sender, amount, quoteOut);
        IPerkLaunchFactory(factory).getLaunch(meme).quote.transfer(msg.sender, quoteOut);
    }

    /// @inheritdoc IPerkGraduationManager
    function previewRedeem(address meme, uint256 amount) external view returns (uint256 quoteOut) {
        Graduation storage g = _graduations[meme];
        if (g.stage != Stage.REFUNDING) return 0;
        return _redeemQuote(meme, g.quoteHeld, amount);
    }

    /// @dev `amount` as a share of the tokens that can still be redeemed, applied to the quote that is left.
    ///      Outstanding supply excludes the grant reserve (never handed out) and anything sitting in this contract,
    ///      so tokens that are burned, stranded or sent here only raise everyone else's share. Pricing each
    ///      redemption on what is left makes the order irrelevant: the last holder takes exactly the remainder.
    function _redeemQuote(address meme, uint256 quoteLeft, uint256 amount) private view returns (uint256) {
        if (amount == 0) return 0;
        IERC20 token = IERC20(meme);
        uint256 outstanding = token.totalSupply() - token.balanceOf(address(this))
            - token.balanceOf(IPerkLaunchFactory(factory).grantReserveHolder());
        if (amount > outstanding) return 0;
        return Math.mulDiv(amount, quoteLeft, outstanding);
    }

    /// @dev Stuck before any liquidity reached the pool: the funds are still in the curve or in this contract. From
    ///      LIQUIDITY_ADDED on, the pool is live and holders can sell there.
    function _rescuable(Stage stage) private pure returns (bool) {
        return stage == Stage.NONE || stage == Stage.FUNDED || stage == Stage.POOL_INITIALIZED;
    }

    /// @dev sqrt(token1/token0) * 2^96 from the curve's virtual reserves (quote per meme = vQuote / vMeme).
    ///      Uniswap price is token1/token0, so quote as token0 means meme/quote (invert).
    function _sqrtPriceX96(uint256 vQuote, uint256 vMeme, bool quoteIsCurrency0) private pure returns (uint160) {
        (uint256 num, uint256 den) = quoteIsCurrency0 ? (vMeme, vQuote) : (vQuote, vMeme);
        uint256 sqrt_ = _sqrtRatioX96(num, den);
        uint256 minP = uint256(TickMath.MIN_SQRT_PRICE) + 1;
        uint256 maxP = uint256(TickMath.MAX_SQRT_PRICE) - 1;
        if (sqrt_ < minP) sqrt_ = minP;
        if (sqrt_ > maxP) sqrt_ = maxP;
        // Clamped to TickMath's uint160 sqrt-price bounds.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint160(sqrt_);
    }

    /// @dev sqrt(num/den) * 2^96.
    ///
    ///      Forming `num * 2^192 / den` up front overflows uint256 whenever `den` is small next to `num`, which is
    ///      exactly what a low-decimal quote produces: a six-decimal quote on a scaled-down curve has a virtual
    ///      reserve in the tens of thousands against a meme reserve of ~1e26, and the intermediate lands around
    ///      1e80 even though the square root itself (~1e40) is comfortably inside the tick range. Graduation then
    ///      reverted with an arithmetic panic and the launch stuck at FUNDED with its curve already drained.
    ///
    ///      So the square root is taken before the last shift when the intermediate would not fit. Ratios that
    ///      already fit keep the original full-precision path, which is every 18-decimal quote.
    function _sqrtRatioX96(uint256 num, uint256 den) private pure returns (uint256) {
        uint256 q96 = uint256(1) << 96;
        uint256 inner = Math.mulDiv(num, q96, den); // num/den, Q96
        // `inner << 96` only fits in uint256 while inner < 2^160
        if (inner < (uint256(1) << 160)) return Math.sqrt(inner << 96);
        // sqrt(inner) * 2^48 == sqrt(num/den) * 2^96; taking the root first costs at most one unit of `inner`,
        // which at this magnitude is far below a wei of price.
        return Math.sqrt(inner) << 48;
    }

    function _quoteOnlyRange(Graduation storage g, PerkTypes.Template memory tmpl, bool quoteIs0)
        private
        view
        returns (bool mint, int24 tickLower, int24 tickUpper, uint128 liq)
    {
        int24 current = TickMath.getTickAtSqrtPrice(g.sqrtPriceX96);
        int24 spacing = tmpl.pool.tickSpacing;
        if (quoteIs0) {
            // Range entirely above current price holds only token0 (quote).
            tickLower = _alignUpExclusive(current, spacing);
            tickUpper = tmpl.pool.tickUpper;
        } else {
            // Range entirely below current price holds only token1 (quote).
            tickLower = tmpl.pool.tickLower;
            tickUpper = _alignDown(current, spacing);
        }
        if (tickLower >= tickUpper) return (mint, 0, 0, 0);

        uint256 amount0 = quoteIs0 ? g.quoteLeftover : 0;
        uint256 amount1 = quoteIs0 ? 0 : g.quoteLeftover;
        liq = LiquidityAmounts.getLiquidityForAmounts(
            g.sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(tickLower),
            TickMath.getSqrtPriceAtTick(tickUpper),
            amount0,
            amount1
        );
        mint = liq > 0;
    }

    function _alignDown(int24 tick, int24 spacing) private pure returns (int24) {
        int24 compressed = tick / spacing;
        if (tick < 0 && tick % spacing != 0) {
            unchecked {
                --compressed;
            }
        }
        // Tick alignment is defined as a multiple of spacing; the remainder was discarded above.
        // forge-lint: disable-next-line(divide-before-multiply)
        return compressed * spacing;
    }

    function _alignUpExclusive(int24 tick, int24 spacing) private pure returns (int24) {
        int24 down = _alignDown(tick, spacing);
        if (down == tick) {
            unchecked {
                return tick + spacing;
            }
        }
        unchecked {
            return down + spacing;
        }
    }

    function _approvePosm(Currency currency) private {
        if (currency.isAddressZero()) return;
        address token = Currency.unwrap(currency);
        if (_permit2Approved[token]) return;
        _permit2Approved[token] = true;
        IERC20(token).forceApprove(address(PERMIT2), type(uint256).max);
        // Allowance is recorded before the call; Permit2 cannot reenter this contract.
        // forge-lint: disable-next-line(reentrancy-no-eth)
        PERMIT2.approve(token, positionManager, type(uint160).max, type(uint48).max);
    }

    function _nonZero(address account) private pure returns (address) {
        if (account == address(0)) revert ZeroAddress();
        return account;
    }
}
