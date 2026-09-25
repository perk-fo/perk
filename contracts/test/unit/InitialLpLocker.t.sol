// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";

import {IPerkGraduationManager} from "../../src/interfaces/IPerkGraduationManager.sol";
import {InitialLpLocker} from "../../src/graduation/InitialLpLocker.sol";
import {GrantTestBase} from "../utils/GrantTestBase.sol";

/// @dev PRD 6 v0.14: the initial (graduation) LP's trading fees go to the launch's Dev, both currencies, and follow
///      the Dev recipient the FeeRouter records. The principal stays locked.
contract InitialLpLockerTest is GrantTestBase {
    event InitialLpFeesCollected(uint256 indexed tokenId, address indexed meme, address indexed dev);

    function setUp() public {
        _setUpPerk();
    }

    function test_collectFees_paysBothCurrenciesToDev_andFollowsSetDevRecipient() public {
        address meme = _graduated(t.erc20Quote, keccak256("locker"));
        IPerkGraduationManager.Graduation memory g = t.graduation.graduationOf(meme);
        uint256 tokenId = g.positionTokenId;
        address dev = t.feeRouter.launchFees(meme).dev;
        assertEq(dev, creator);
        _trade(meme, g.key);

        uint256 devQuote = t.quoteToken.balanceOf(dev);
        uint256 devMeme = IERC20(meme).balanceOf(dev);
        uint256 treasuryQuote = t.quoteToken.balanceOf(address(t.treasury));
        uint128 liquidity = t.positionManager.getPositionLiquidity(tokenId);
        vm.expectEmit(true, true, true, true, address(t.locker));
        emit InitialLpFeesCollected(tokenId, meme, dev);
        vm.prank(stranger); // anyone may trigger it
        t.locker.collectFees(tokenId);
        assertGt(t.quoteToken.balanceOf(dev), devQuote, "quote fees to the dev");
        assertGt(IERC20(meme).balanceOf(dev), devMeme, "meme fees to the dev");
        assertEq(t.quoteToken.balanceOf(address(t.treasury)), treasuryQuote, "nothing to the treasury");
        assertEq(t.quoteToken.balanceOf(stranger), 10_000_000 ether);
        assertEq(t.positionManager.getPositionLiquidity(tokenId), liquidity, "principal stays locked");
        assertEq(IERC721(address(t.positionManager)).ownerOf(tokenId), address(t.locker));

        // the dev hands the launch to a new recipient: later collections follow it
        address newDev = makeAddr("newDev");
        vm.prank(creator);
        t.feeRouter.setDevRecipient(meme, newDev);
        _trade(meme, g.key);
        devQuote = t.quoteToken.balanceOf(creator);
        devMeme = IERC20(meme).balanceOf(creator);
        vm.expectEmit(true, true, true, true, address(t.locker));
        emit InitialLpFeesCollected(tokenId, meme, newDev);
        t.locker.collectFees(tokenId);
        assertGt(t.quoteToken.balanceOf(newDev), 0);
        assertGt(IERC20(meme).balanceOf(newDev), 0);
        assertEq(t.quoteToken.balanceOf(creator), devQuote, "the old dev receives nothing more");
        assertEq(IERC20(meme).balanceOf(creator), devMeme);
    }

    function test_collectFees_nativeQuote_paysDev() public {
        address meme = _graduated(t.nativeQuote, keccak256("locker-native"));
        IPerkGraduationManager.Graduation memory g = t.graduation.graduationOf(meme);
        address dev = t.feeRouter.launchFees(meme).dev;
        bool q0 = g.key.currency0 == t.nativeQuote;
        _swap(g.key, q0, 5 ether, 5 ether);
        uint256 before = dev.balance;
        t.locker.collectFees(g.positionTokenId);
        assertGt(dev.balance, before);
    }

    function test_constructor_reverts_zeroAddress() public {
        vm.expectRevert(InitialLpLocker.ZeroAddress.selector);
        new InitialLpLocker(address(0), address(t.feeRouter));
        vm.expectRevert(InitialLpLocker.ZeroAddress.selector);
        new InitialLpLocker(address(t.positionManager), address(0));
        assertEq(t.locker.feeRouter(), address(t.feeRouter));
    }

    /// @dev Swaps both ways so the locked position accrues fees in quote and in meme.
    function _trade(address meme, PoolKey memory key) internal {
        bool q0 = _quoteIs0(meme);
        _swap(key, q0, 20 ether, 0);
        uint256 inventory = IERC20(meme).balanceOf(buyer) / 10;
        vm.prank(buyer);
        IERC20(meme).transfer(swapper, inventory);
        _sellMeme(key, q0, meme, inventory);
    }
}
