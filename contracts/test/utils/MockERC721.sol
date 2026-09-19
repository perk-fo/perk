// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

/// @dev Minimal ERC-721 used to push a token onto an IERC721Receiver via `safeTransferFrom`.
contract MockERC721 {
    mapping(uint256 id => address owner) public ownerOf;

    error NotOwner();

    function mint(address to, uint256 id) external {
        ownerOf[id] = to;
    }

    function safeTransferFrom(address from, address to, uint256 id) external {
        if (ownerOf[id] != from) revert NotOwner();
        ownerOf[id] = to;
        IERC721Receiver(to).onERC721Received(msg.sender, from, id, "");
    }
}
