// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Currency, CurrencyLibrary} from "v4-core/src/types/Currency.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";

import {IPerkLaunchFactory} from "../interfaces/IPerkLaunchFactory.sol";
import {IPerkTemplateRegistry} from "../interfaces/IPerkTemplateRegistry.sol";
import {IPerkModuleRegistry} from "../interfaces/IPerkModuleRegistry.sol";
import {IPerkAssetRegistry} from "../interfaces/IPerkAssetRegistry.sol";
import {IPerkHolderRewardDistributor} from "../interfaces/IPerkHolderRewardDistributor.sol";
import {IPerkFeeRouter} from "../interfaces/IPerkFeeRouter.sol";
import {IPerkBondingCurve} from "../interfaces/IPerkBondingCurve.sol";
import {PerkMemeToken} from "../token/PerkMemeToken.sol";
import {BondingCurve} from "../curve/BondingCurve.sol";
import {PerkTypes} from "../libraries/PerkTypes.sol";
import {PerkConstants} from "../libraries/PerkConstants.sol";

/// @title LaunchFactory
/// @notice Deploys a meme per launch from an ACTIVE template and commits its configHash.
contract LaunchFactory is IPerkLaunchFactory, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using CurrencyLibrary for Currency;

    error AlreadyWired();

    struct ValidatedLaunch {
        address predictedMeme;
        uint256 moduleBitmap;
        bytes32 moduleParamsHash;
        bytes32 configHash;
        PerkTypes.Template template;
    }

    /// @inheritdoc IPerkLaunchFactory
    address public immutable override templateRegistry;
    /// @inheritdoc IPerkLaunchFactory
    address public immutable override moduleRegistry;
    /// @inheritdoc IPerkLaunchFactory
    address public immutable override assetRegistry;
    /// @inheritdoc IPerkLaunchFactory
    address public immutable override poolManager;
    /// @inheritdoc IPerkLaunchFactory
    address public immutable override treasury;

    /// @inheritdoc IPerkLaunchFactory
    address public override curve;
    /// @inheritdoc IPerkLaunchFactory
    address public override feeRouter;
    /// @inheritdoc IPerkLaunchFactory
    address public override distributor;
    /// @inheritdoc IPerkLaunchFactory
    address public override hook;
    /// @inheritdoc IPerkLaunchFactory
    address public override graduationManager;
    /// @inheritdoc IPerkLaunchFactory
    address public override grantReserveHolder;

    /// @inheritdoc IPerkLaunchFactory
    mapping(bytes32 launchId => address meme) public override launchByLaunchId;
    /// @inheritdoc IPerkLaunchFactory
    uint256 public override launchCount;

    mapping(address meme => PerkTypes.LaunchRecord) private _launches;

    /// @param owner_ Two-step Ownable owner.
    /// @param templateRegistry_ Template registry used to resolve ACTIVE launch templates.
    /// @param moduleRegistry_ Module registry used for bitmap / quote compatibility.
    /// @param assetRegistry_ Quote-asset whitelist.
    /// @param poolManager_ Uniswap v4 PoolManager, excluded from Quote Rewards.
    /// @param treasury_ Community treasury, excluded from Quote Rewards.
    constructor(
        address owner_,
        address templateRegistry_,
        address moduleRegistry_,
        address assetRegistry_,
        address poolManager_,
        address treasury_
    ) Ownable(_nonZero(owner_)) {
        if (
            templateRegistry_ == address(0) || moduleRegistry_ == address(0) || assetRegistry_ == address(0)
                || poolManager_ == address(0) || treasury_ == address(0)
        ) {
            revert ZeroAddress();
        }
        templateRegistry = templateRegistry_;
        moduleRegistry = moduleRegistry_;
        assetRegistry = assetRegistry_;
        poolManager = poolManager_;
        treasury = treasury_;
    }

    /// @inheritdoc IPerkLaunchFactory
    uint256 public override pausedFlags;

    /// @inheritdoc IPerkLaunchFactory
    uint64 public override graduationResumedAt;

    /// @notice Accepts native quote refunded by the curve on a graduating dev buy.
    receive() external payable {}

    /// @inheritdoc IPerkLaunchFactory
    function setPaused(uint256 flags) external override onlyOwner {
        if (flags & ~PerkConstants.PAUSE_ALL != 0) revert UnknownPauseArea(flags);
        if (pausedFlags & PerkConstants.PAUSE_GRADUATION != 0 && flags & PerkConstants.PAUSE_GRADUATION == 0) {
            // forge-lint: disable-next-line(unsafe-typecast)
            graduationResumedAt = uint64(block.timestamp);
        }
        pausedFlags = flags;
        emit PauseUpdated(flags);
    }

    /// @inheritdoc IPerkLaunchFactory
    function isPaused(uint256 area) public view override returns (bool) {
        return pausedFlags & area != 0;
    }

    /// @notice One-time wiring of contracts deployed after the factory. Owner only.
    /// @dev Also calls `BondingCurve.wire(graduationManager)` (curve `wire` is `onlyFactory`).
    /// @param curve_ Bonding curve singleton.
    /// @param feeRouter_ Fee router singleton.
    /// @param distributor_ Holder-reward distributor singleton.
    /// @param hook_ Composable hook (flag-encoded address).
    /// @param graduationManager_ Graduation manager (or placeholder).
    /// @param grantReserveHolder_ Grant-reserve escrow until LPGrantVault ships.
    function wire(
        address curve_,
        address feeRouter_,
        address distributor_,
        address hook_,
        address graduationManager_,
        address grantReserveHolder_
    ) external onlyOwner {
        if (curve != address(0)) revert AlreadyWired();
        if (
            curve_ == address(0) || feeRouter_ == address(0) || distributor_ == address(0) || hook_ == address(0)
                || graduationManager_ == address(0) || grantReserveHolder_ == address(0)
        ) {
            revert ZeroAddress();
        }
        curve = curve_;
        feeRouter = feeRouter_;
        distributor = distributor_;
        hook = hook_;
        graduationManager = graduationManager_;
        grantReserveHolder = grantReserveHolder_;
        // One-time wire; no interface event exists for this assignment.
        // forge-lint: disable-next-line(missing-events-access-control)
        BondingCurve(curve_).wire(graduationManager_);
    }

    /// @inheritdoc IPerkLaunchFactory
    function previewLaunch(PerkTypes.CreateLaunchParams calldata params)
        external
        view
        override
        returns (address predictedMeme, address hook_, uint256 moduleBitmap, bytes32 configHash)
    {
        ValidatedLaunch memory v = _validate(params, msg.sender);
        predictedMeme = v.predictedMeme;
        hook_ = hook;
        moduleBitmap = v.moduleBitmap;
        configHash = v.configHash;
    }

    /// @inheritdoc IPerkLaunchFactory
    function createLaunch(PerkTypes.CreateLaunchParams calldata params)
        external
        payable
        override
        nonReentrant
        returns (address meme, bytes32 launchId)
    {
        if (isPaused(PerkConstants.PAUSE_LAUNCH)) revert Paused(PerkConstants.PAUSE_LAUNCH);
        address creator = msg.sender;
        ValidatedLaunch memory v = _validate(params, creator);
        if (params.expectedConfigHash != v.configHash) {
            revert ConfigHashMismatch(params.expectedConfigHash, v.configHash);
        }
        if (_launches[v.predictedMeme].createdAt != 0) revert LaunchExists();
        launchId = _storeLaunch(v.predictedMeme, creator, params, v);

        _pullDevBuyQuote(params.quote, params.devBuyQuote);

        address[] memory excluded = _excludedAddresses();
        IPerkHolderRewardDistributor(distributor)
            .registerMeme(v.predictedMeme, params.quote, feeRouter, v.template.minEligibleBalance, excluded);
        IPerkFeeRouter(feeRouter)
            .registerLaunch(v.predictedMeme, params.quote, creator, curve, v.template.totalFeeBps, v.template.feeSplit);

        meme = _deployMeme(creator, params, v);
        _fundCurveAndGrant(meme, v.template.supply);
        _initCurve(meme, params.quote, v.template);
        _emitLaunchEvents(launchId, meme, creator, params, v);

        if (params.devBuyQuote > 0) {
            _executeDevBuy(meme, params.quote, params.devBuyQuote, creator);
        }
    }

    /// @inheritdoc IPerkLaunchFactory
    function computeConfigHash(
        address creator,
        address predictedMeme,
        Currency quote,
        bytes32 templateId,
        uint32 hookVersion,
        uint256 moduleBitmap,
        bytes32 moduleParamsHash
    ) public view override returns (bytes32) {
        return keccak256(
            abi.encode(
                block.chainid,
                address(this),
                creator,
                predictedMeme,
                quote,
                templateId,
                hookVersion,
                moduleBitmap,
                moduleParamsHash
            )
        );
    }

    /// @inheritdoc IPerkLaunchFactory
    function predictMemeAddress(
        address creator,
        bytes32 salt,
        PerkTypes.TokenMetadata calldata metadata,
        uint256 totalSupply
    ) public view override returns (address) {
        _requireWired();
        bytes32 salt2 = keccak256(abi.encode(creator, salt));
        bytes memory initCode = bytes.concat(
            type(PerkMemeToken).creationCode,
            abi.encode(metadata.name, metadata.symbol, metadata.uri, totalSupply, distributor)
        );
        return Create2.computeAddress(salt2, keccak256(initCode), address(this));
    }

    /// @inheritdoc IPerkLaunchFactory
    function setLaunchStatus(address meme, PerkTypes.LaunchStatus status, PoolId poolId) external override {
        PerkTypes.LaunchRecord storage rec = _launches[meme];
        if (rec.createdAt == 0) revert LaunchNotFound();

        if (msg.sender == curve) {
            if (
                rec.status != PerkTypes.LaunchStatus.CURVE_ACTIVE || status != PerkTypes.LaunchStatus.GRADUATION_PENDING
            ) {
                revert InvalidStatusTransition();
            }
        } else if (msg.sender == graduationManager) {
            if (rec.status != PerkTypes.LaunchStatus.GRADUATION_PENDING) revert InvalidStatusTransition();
            if (status == PerkTypes.LaunchStatus.GRADUATED) rec.poolId = poolId;
            else if (status != PerkTypes.LaunchStatus.REFUNDING) revert InvalidStatusTransition();
        } else {
            revert NotStatusUpdater();
        }

        rec.status = status;
        emit LaunchStatusUpdated(meme, status, poolId);
    }

    /// @inheritdoc IPerkLaunchFactory
    function getLaunch(address meme) external view override returns (PerkTypes.LaunchRecord memory) {
        return _launches[meme];
    }

    function _validate(PerkTypes.CreateLaunchParams calldata params, address creator)
        private
        view
        returns (ValidatedLaunch memory v)
    {
        _requireWired();
        if (!IPerkTemplateRegistry(templateRegistry).isActive(params.templateId)) revert TemplateNotActive();
        if (!IPerkAssetRegistry(assetRegistry).isQuoteAllowed(params.quote)) revert QuoteNotAllowed();

        (v.moduleBitmap, v.moduleParamsHash) = IPerkTemplateRegistry(templateRegistry)
            .validateConfiguration(params.templateId, params.quote, params.moduleParams);

        (bool ok, string memory reason) =
            IPerkModuleRegistry(moduleRegistry).validateCompatibility(v.moduleBitmap, params.quote);
        if (!ok) revert ModuleIncompatible(reason);

        v.template = IPerkTemplateRegistry(templateRegistry).getTemplate(params.templateId);
        v.predictedMeme = predictMemeAddress(creator, params.salt, params.metadata, v.template.supply.totalSupply);
        v.configHash = computeConfigHash(
            creator,
            v.predictedMeme,
            params.quote,
            params.templateId,
            v.template.hookVersion,
            v.moduleBitmap,
            v.moduleParamsHash
        );
    }

    function _pullDevBuyQuote(Currency quote, uint256 devBuyQuote) private {
        if (quote.isAddressZero()) {
            if (msg.value != devBuyQuote) revert NativeAmountMismatch();
        } else {
            if (msg.value != 0) revert NativeAmountMismatch();
            if (devBuyQuote != 0) {
                IERC20(Currency.unwrap(quote)).safeTransferFrom(msg.sender, address(this), devBuyQuote);
            }
        }
    }

    function _deployMeme(address creator, PerkTypes.CreateLaunchParams calldata params, ValidatedLaunch memory v)
        private
        returns (address meme)
    {
        bytes32 salt2 = keccak256(abi.encode(creator, params.salt));
        PerkMemeToken token = new PerkMemeToken{salt: salt2}(
            params.metadata.name,
            params.metadata.symbol,
            params.metadata.uri,
            v.template.supply.totalSupply,
            distributor
        );
        meme = address(token);
        if (meme != v.predictedMeme) revert MemeAddressMismatch();
    }

    function _fundCurveAndGrant(address meme, PerkTypes.SupplyPlan memory supply) private {
        uint256 toCurve = supply.curveSupply + supply.poolReserveSupply;
        IERC20(meme).safeTransfer(curve, toCurve);
        if (supply.grantReserveSupply != 0) {
            IERC20(meme).safeTransfer(grantReserveHolder, supply.grantReserveSupply);
        }
    }

    function _storeLaunch(
        address meme,
        address creator,
        PerkTypes.CreateLaunchParams calldata params,
        ValidatedLaunch memory v
    ) private returns (bytes32 launchId) {
        launchId = keccak256(abi.encode(block.chainid, address(this), meme));
        // timestamp is launch metadata and fits uint64 for any realistic chain lifetime
        // forge-lint: disable-next-line(block-timestamp, unsafe-typecast)
        uint64 createdAt_ = uint64(block.timestamp);
        _launches[meme] = PerkTypes.LaunchRecord({
            launchId: launchId,
            creator: creator,
            meme: meme,
            quote: params.quote,
            templateId: params.templateId,
            hookVersion: v.template.hookVersion,
            moduleBitmap: v.moduleBitmap,
            moduleParamsHash: v.moduleParamsHash,
            configHash: v.configHash,
            hook: hook,
            lpGrantEnabled: v.template.grant.enabled,
            status: PerkTypes.LaunchStatus.CURVE_ACTIVE,
            createdAt: createdAt_,
            poolId: PoolId.wrap(bytes32(0))
        });
        launchByLaunchId[launchId] = meme;
        unchecked {
            ++launchCount;
        }
    }

    function _emitLaunchEvents(
        bytes32 launchId,
        address meme,
        address creator,
        PerkTypes.CreateLaunchParams calldata params,
        ValidatedLaunch memory v
    ) private {
        // External calls in createLaunch follow the specified register-then-deploy order.
        // forge-lint: disable-next-line(reentrancy-events)
        emit LaunchCreated(launchId, meme, creator, params.quote, params.templateId, v.configHash);
        uint32 hookVersion = v.template.hookVersion;
        uint256 bitmap = v.moduleBitmap;
        bytes32 paramsHash = v.moduleParamsHash;
        // forge-lint: disable-next-line(reentrancy-events)
        emit LaunchTemplateSelected(launchId, params.templateId, hookVersion, bitmap, paramsHash);
        // forge-lint: disable-next-line(reentrancy-events)
        emit HookModulesCommitted(launchId, hook, bitmap, v.configHash);
        // forge-lint: disable-next-line(reentrancy-events)
        emit LaunchStatusUpdated(meme, PerkTypes.LaunchStatus.CURVE_ACTIVE, PoolId.wrap(bytes32(0)));
    }

    function _executeDevBuy(address meme, Currency quote, uint256 devBuyQuote, address creator) private {
        uint256 memeOut;
        uint256 quoteUsed;
        uint256 quoteRefund;
        if (quote.isAddressZero()) {
            // Destination is the wired curve singleton, not a user-supplied address.
            (memeOut, quoteUsed, quoteRefund) =
                IPerkBondingCurve(curve).buy{value: devBuyQuote}(meme, devBuyQuote, 0, creator); // forge-lint: disable-line(arbitrary-send-eth)
        } else {
            IERC20(Currency.unwrap(quote)).forceApprove(curve, devBuyQuote);
            (memeOut, quoteUsed, quoteRefund) = IPerkBondingCurve(curve).buy(meme, devBuyQuote, 0, creator);
        }
        if (quoteRefund != 0) {
            CurrencyLibrary.transfer(quote, creator, quoteRefund);
        }
        // forge-lint: disable-next-line(reentrancy-events)
        emit DevBuyExecuted(meme, creator, quoteUsed, memeOut);
    }

    function _initCurve(address meme, Currency quote, PerkTypes.Template memory tmpl) private {
        IPerkBondingCurve(curve)
            .initCurve(
                meme,
                IPerkBondingCurve.CurveConfig({
                    quote: quote,
                    virtualQuoteReserve: tmpl.curve.virtualQuoteReserve,
                    virtualMemeReserve: tmpl.curve.virtualMemeReserve,
                    curveSupply: tmpl.supply.curveSupply,
                    poolReserveSupply: tmpl.supply.poolReserveSupply,
                    graduationQuoteThreshold: tmpl.curve.graduationQuoteThreshold,
                    totalFeeBps: tmpl.totalFeeBps
                })
            );
    }

    function _excludedAddresses() private view returns (address[] memory excluded) {
        excluded = new address[](9);
        excluded[0] = poolManager;
        excluded[1] = curve;
        excluded[2] = address(this);
        excluded[3] = grantReserveHolder;
        excluded[4] = feeRouter;
        excluded[5] = treasury;
        excluded[6] = distributor;
        excluded[7] = hook;
        excluded[8] = graduationManager;
    }

    function _requireWired() private view {
        if (distributor == address(0)) revert ZeroAddress();
    }

    function _nonZero(address account) private pure returns (address) {
        if (account == address(0)) revert ZeroAddress();
        return account;
    }
}
