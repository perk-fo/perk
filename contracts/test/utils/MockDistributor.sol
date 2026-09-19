// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev Records `accrueQuoteRewards` calls and pulls ERC-20 like HolderRewardDistributor.
contract MockDistributor {
    using SafeERC20 for IERC20;

    struct AccrueCall {
        address meme;
        uint256 quoteAmount;
        uint256 value;
    }

    AccrueCall[] public calls;
    IERC20 public quoteToken;

    function setQuoteToken(IERC20 token) external {
        quoteToken = token;
    }

    function accrueQuoteRewards(address meme, uint256 quoteAmount) external payable {
        if (address(quoteToken) != address(0) && msg.value == 0) {
            quoteToken.safeTransferFrom(msg.sender, address(this), quoteAmount);
        }
        calls.push(AccrueCall({meme: meme, quoteAmount: quoteAmount, value: msg.value}));
    }

    function callCount() external view returns (uint256) {
        return calls.length;
    }

    function lastAccrueAmount() external view returns (uint256) {
        if (calls.length == 0) return 0;
        return calls[calls.length - 1].quoteAmount;
    }

    receive() external payable {}
}
