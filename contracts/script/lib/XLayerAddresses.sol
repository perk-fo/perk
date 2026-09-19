// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/// @title XLayerAddresses
/// @notice Canonical Uniswap v4 addresses on X Layer. Testnet has no official v4; scripts deploy a local stack.
library XLayerAddresses {
    uint256 internal constant MAINNET_CHAIN_ID = 196;
    uint256 internal constant TESTNET_CHAIN_ID = 1952;

    /// @dev Canonical Permit2, same address on every chain that used Nick's factory.
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    // ---- X Layer mainnet (chainId 196) ----
    address internal constant POOL_MANAGER = 0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32;
    address internal constant POSITION_MANAGER = 0xcF1EAFC6928dC385A342E7C6491d371d2871458b;
    address internal constant UNIVERSAL_ROUTER = 0xDa00aE15d3A71466517129255255db7c0c0956d3;
    address internal constant STATE_VIEW = 0x76Fd297e2D437cd7f76d50F01AfE6160f86e9990;
    address internal constant QUOTER = 0x8928074CA1b241D8Ec02815881c1Af11E8bC5219;
}
