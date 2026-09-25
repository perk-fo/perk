// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {Actions} from "v4-periphery/src/libraries/Actions.sol";

import {IPerkComposableHook} from "../interfaces/IPerkComposableHook.sol";
import {IPerkFeeRouter} from "../interfaces/IPerkFeeRouter.sol";

/// @title InitialLpLocker
/// @notice Holds PositionManager ERC-721s minted at graduation. Never transfers or decreases liquidity.
/// @dev The only mutation is `collectFees`, which takes the accrued trading fees, both currencies, to the launch's
///      current Dev recipient as the FeeRouter records it (PRD 6 v0.14). The principal stays locked forever.
contract InitialLpLocker is IERC721Receiver {
    using PoolIdLibrary for PoolKey;

    IPositionManager internal immutable POSITION_MANAGER;
    /// @notice FeeRouter whose `launchFees(meme).dev` receives the initial LP's fees.
    address public immutable feeRouter;

    /// @notice Fees accrued on `tokenId`, both currencies, were paid to `dev`, the Dev recipient of `meme`.
    event InitialLpFeesCollected(uint256 indexed tokenId, address indexed meme, address indexed dev);

    error NotPositionManager();
    error ZeroAddress();

    /// @param positionManager_ Uniswap v4 PositionManager that mints the locked NFTs.
    /// @param feeRouter_ Perk FeeRouter; its per-launch Dev recipient is where collected fees go.
    constructor(address positionManager_, address feeRouter_) {
        if (positionManager_ == address(0) || feeRouter_ == address(0)) revert ZeroAddress();
        POSITION_MANAGER = IPositionManager(positionManager_);
        feeRouter = feeRouter_;
    }

    /// @notice Accepts PositionManager ERC-721s only. Reverts for any other operator.
    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        if (msg.sender != address(POSITION_MANAGER)) revert NotPositionManager();
        return this.onERC721Received.selector;
    }

    /// @notice Collects accrued fees on `tokenId`, both currencies, to the launch's current Dev recipient. Anyone may
    ///         call. Liquidity is unchanged.
    /// @dev The launch is read from the official pool: the hook records its meme, the FeeRouter its Dev, so a Dev
    ///      recipient moved with `FeeRouter.setDevRecipient` receives every later collection.
    /// @param tokenId PositionManager token owned by this locker.
    function collectFees(uint256 tokenId) external {
        // PositionInfo is unused; collectFees only needs the pool key.
        // forge-lint: disable-next-line(unused-return)
        (PoolKey memory key,) = POSITION_MANAGER.getPoolAndPositionInfo(tokenId);
        address meme = IPerkComposableHook(address(key.hooks)).poolInfo(key.toId()).meme;
        address dev = IPerkFeeRouter(feeRouter).launchFees(meme).dev;
        if (meme == address(0) || dev == address(0)) revert ZeroAddress();

        bytes memory actions = abi.encodePacked(_actionByte(Actions.DECREASE_LIQUIDITY), _actionByte(Actions.TAKE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(tokenId, uint256(0), uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1, dev);
        emit InitialLpFeesCollected(tokenId, meme, dev);
        // Deadline is the current block; the modifier is `>` so equality is valid.
        // forge-lint: disable-next-line(block-timestamp)
        POSITION_MANAGER.modifyLiquidities(abi.encode(actions, params), block.timestamp);
    }

    function _actionByte(uint256 action) private pure returns (bytes1) {
        // Actions IDs are constants well below 256.
        // forge-lint: disable-next-line(unsafe-typecast)
        return bytes1(uint8(action));
    }
}
