// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPerkHolderRewardDistributor} from "../../src/interfaces/IPerkHolderRewardDistributor.sol";

/// @dev Test fee router used as `msg.sender` for `accrueQuoteRewards`.
contract MockFeeRouter {
    IPerkHolderRewardDistributor public immutable distributor;

    constructor(IPerkHolderRewardDistributor distributor_) {
        distributor = distributor_;
    }

    function accrue(address meme, uint256 quoteAmount) external payable {
        distributor.accrueQuoteRewards{value: msg.value}(meme, quoteAmount);
    }

    function approveQuote(IERC20 token, uint256 amount) external {
        token.approve(address(distributor), amount);
    }

    receive() external payable {}
}
