// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/// @dev OpenZeppelin-compatible sorted-pair Merkle tree. Leaf count must be a power of two.
library MerkleTree {
    error NotPowerOfTwo();
    error IndexOOB();

    function leaf(address account, uint256 baseAllocation, uint256 inviteeBoost) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(account, baseAllocation, inviteeBoost))));
    }

    function hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function root(bytes32[] memory leaves) internal pure returns (bytes32) {
        bytes32[] memory layer = _requirePow2(leaves);
        while (layer.length > 1) {
            layer = _nextLayer(layer);
        }
        return layer[0];
    }

    function proof(bytes32[] memory leaves, uint256 index) internal pure returns (bytes32[] memory out) {
        bytes32[] memory layer = _requirePow2(leaves);
        if (index >= layer.length) revert IndexOOB();
        uint256 levels;
        for (uint256 n = layer.length; n > 1; n >>= 1) {
            ++levels;
        }
        out = new bytes32[](levels);
        uint256 idx = index;
        for (uint256 p; p < levels; ++p) {
            out[p] = layer[idx ^ 1];
            layer = _nextLayer(layer);
            idx >>= 1;
        }
    }

    function _requirePow2(bytes32[] memory leaves) private pure returns (bytes32[] memory) {
        uint256 n = leaves.length;
        if (n == 0 || (n & (n - 1)) != 0) revert NotPowerOfTwo();
        return leaves;
    }

    function _nextLayer(bytes32[] memory layer) private pure returns (bytes32[] memory next) {
        next = new bytes32[](layer.length / 2);
        for (uint256 i; i < next.length; ++i) {
            next[i] = hashPair(layer[2 * i], layer[2 * i + 1]);
        }
    }
}
