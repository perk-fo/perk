// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IPerkMemeToken} from "../interfaces/IPerkMemeToken.sol";
import {IPerkHolderRewardDistributor} from "../interfaces/IPerkHolderRewardDistributor.sol";

/// @title PerkMemeToken
/// @notice Fixed-supply ERC-20 that checkpoints every balance change into the holder reward distributor.
contract PerkMemeToken is ERC20, IPerkMemeToken {
    error DistributorNotContract();

    /// @inheritdoc IPerkMemeToken
    address public immutable override factory;

    /// @inheritdoc IPerkMemeToken
    address public immutable override distributor;

    /// @inheritdoc IPerkMemeToken
    string public override tokenURI;

    /// @param name_ ERC-20 name.
    /// @param symbol_ ERC-20 symbol.
    /// @param uri Off-chain metadata URI.
    /// @param totalSupply_ Fixed supply minted to the factory (`msg.sender`).
    /// @param distributor_ Holder reward distributor that receives balance checkpoints.
    constructor(
        string memory name_,
        string memory symbol_,
        string memory uri,
        uint256 totalSupply_,
        address distributor_
    ) ERC20(name_, symbol_) {
        factory = msg.sender;
        // A high-level call to an address without code reverts before try/catch can intercept it, which would freeze
        // every transfer. Refuse to deploy against anything that is not a contract.
        if (distributor_ == address(0) || distributor_.code.length == 0) revert DistributorNotContract();
        distributor = distributor_;
        tokenURI = uri;
        _mint(msg.sender, totalSupply_);
    }

    /// @inheritdoc IERC20Metadata
    function decimals() public pure override(ERC20, IERC20Metadata) returns (uint8) {
        return 18;
    }

    /// @inheritdoc IPerkMemeToken
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }

    /// @dev Checkpoints both sides of a transfer after balances move. Never reverts because of the distributor (ADR-003).
    function _update(address from, address to, uint256 value) internal override {
        uint256 fromOld = from == address(0) ? 0 : balanceOf(from);
        uint256 toOld = to == address(0) ? 0 : balanceOf(to);

        super._update(from, to, value);

        if (from != address(0)) {
            _checkpoint(from, fromOld, balanceOf(from));
        }
        if (to != address(0) && to != from) {
            _checkpoint(to, toOld, balanceOf(to));
        }
    }

    function _checkpoint(address account, uint256 oldBalance, uint256 newBalance) private {
        try IPerkHolderRewardDistributor(distributor).onBalanceChange(account, oldBalance, newBalance) {}
        catch {
            // forge-lint: disable-next-line(reentrancy-events)
            emit RewardCheckpointFailed(account, oldBalance, newBalance);
        }
    }
}
