// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {Actions} from "v4-periphery/src/libraries/Actions.sol";

/// @title InitialLpLocker
/// @notice Holds PositionManager ERC-721s minted at graduation. Never transfers or decreases liquidity.
/// @dev The only mutation is `collectFees`, which takes accrued fees to `feeRecipient` (V1: CommunityTreasury).
contract InitialLpLocker is IERC721Receiver {
    IPositionManager internal immutable POSITION_MANAGER;
    address public immutable feeRecipient;

    error NotPositionManager();
    error ZeroAddress();

    /// @param positionManager_ Uniswap v4 PositionManager that mints the locked NFTs.
    /// @param feeRecipient_ Immutable recipient of collected swap fees (PRD issue #12).
    constructor(address positionManager_, address feeRecipient_) {
        if (positionManager_ == address(0) || feeRecipient_ == address(0)) revert ZeroAddress();
        POSITION_MANAGER = IPositionManager(positionManager_);
        feeRecipient = feeRecipient_;
    }

    /// @notice Accepts PositionManager ERC-721s only. Reverts for any other operator.
    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        if (msg.sender != address(POSITION_MANAGER)) revert NotPositionManager();
        return this.onERC721Received.selector;
    }

    /// @notice Collects accrued fees on `tokenId` to `feeRecipient`. Anyone may call. Liquidity is unchanged.
    /// @param tokenId PositionManager token owned by this locker.
    function collectFees(uint256 tokenId) external {
        // PositionInfo is unused; collectFees only needs the pool currencies for TAKE_PAIR.
        // forge-lint: disable-next-line(unused-return)
        (PoolKey memory key,) = POSITION_MANAGER.getPoolAndPositionInfo(tokenId);
        bytes memory actions = abi.encodePacked(_actionByte(Actions.DECREASE_LIQUIDITY), _actionByte(Actions.TAKE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(tokenId, uint256(0), uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1, feeRecipient);
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
