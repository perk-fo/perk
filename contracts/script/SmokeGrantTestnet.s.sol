// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IPerkLPGrantVault} from "../src/interfaces/IPerkLPGrantVault.sol";
import {IPerkLaunchFactory} from "../src/interfaces/IPerkLaunchFactory.sol";
import {IPerkGraduationManager} from "../src/interfaces/IPerkGraduationManager.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PerkTypes} from "../src/libraries/PerkTypes.sol";

/// @notice Testnet-only, status-driven LP Grant smoke for a meme created by `SmokeTestnet.s.sol` (env SMOKE_MEME).
///         Run it repeatedly; each run advances the campaign as far as time allows:
///         AWAITING_ROOT  -> propose a one-leaf root (the deployer gets 1,000,000 meme of base allocation)
///         ROOT_PROPOSED  -> after the delay: activateRoot, registerAllocation, activateGrant with 0.002 OKB max
///         ACTIVE         -> collectGrantFees on the deployer's positions; after minLp: exitGrantPosition
contract SmokeGrantTestnet is Script {
    uint256 internal constant BASE = 1_000_000 ether;

    function run() external {
        require(block.chainid != 196, "testnet only");
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address meme = vm.envAddress("SMOKE_MEME");
        string memory json =
            vm.readFile(string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json"));
        IPerkLPGrantVault vault = IPerkLPGrantVault(payable(vm.parseJsonAddress(json, ".lpGrantVault")));
        IPerkLaunchFactory factory = IPerkLaunchFactory(vm.parseJsonAddress(json, ".factory"));
        require(uint256(factory.getLaunch(meme).status) == uint256(PerkTypes.LaunchStatus.GRADUATED), "not graduated");

        IPerkLPGrantVault.GrantLeaf memory leaf =
            IPerkLPGrantVault.GrantLeaf({account: deployer, baseAllocation: BASE, inviteeBoost: 0});
        bytes32 root = vault.leafHash(leaf); // single-leaf tree: root == leaf, empty proof
        IPerkLPGrantVault.Campaign memory c = vault.campaign(meme);
        console2.log("campaign status", uint256(c.status));

        vm.startBroadcast(pk);
        if (c.status == IPerkLPGrantVault.CampaignStatus.AWAITING_ROOT) {
            vault.proposeRoot(meme, root, "ipfs://smoke-single-leaf", BASE, 0);
            console2.log("root proposed; activatable after delay");
        } else if (c.status == IPerkLPGrantVault.CampaignStatus.ROOT_PROPOSED) {
            vault.activateRoot(meme);
            bytes32[] memory proof;
            vault.registerAllocation(meme, leaf, proof);
            _activate(vault, meme, deployer);
        } else if (c.status == IPerkLPGrantVault.CampaignStatus.ACTIVE) {
            // positionsOf spans every meme of a beneficiary; keep only this campaign's live positions
            uint256[] memory all = vault.positionsOf(deployer);
            uint256 live;
            for (uint256 i; i < all.length; ++i) {
                IPerkLPGrantVault.GrantPosition memory q = vault.position(all[i]);
                if (q.meme == meme && !q.exited) ++live;
            }
            if (live == 0 && vault.allocation(meme, deployer).registered) {
                _activate(vault, meme, deployer);
                all = vault.positionsOf(deployer);
            }
            _tinySwap(json, meme); // generate some fees for the positions below
            uint256[] memory ids = all;
            for (uint256 i; i < ids.length; ++i) {
                IPerkLPGrantVault.GrantPosition memory p = vault.position(ids[i]);
                if (p.exited || p.meme != meme) continue;
                if (block.timestamp >= p.activatedAt + c.minLpSeconds) {
                    (uint256 toUser, uint256 memeToUser, uint256 toTreasury, uint256 burned) =
                        vault.exitGrantPosition(ids[i], 0, 0);
                    console2.log("exited position", ids[i]);
                    console2.log("quote to user", toUser);
                    console2.log("meme to user", memeToUser);
                    console2.log("quote to treasury", toTreasury);
                    console2.log("meme burned", burned);
                } else {
                    (uint256 qf, uint256 mf) = vault.collectGrantFees(ids[i]);
                    console2.log("collected fees for position", ids[i]);
                    console2.log("quote fees", qf);
                    console2.log("meme fees", mf);
                }
            }
        }
        vm.stopBroadcast();
        c = vault.campaign(meme);
        console2.log("campaign status now", uint256(c.status));
    }

    /// @dev Buys 0.0005 OKB of meme on the official pool through the testnet swap router so grant positions earn fees.
    function _tinySwap(string memory json, address meme) internal {
        address routerAddr = vm.envOr("V4_TESTNET_SWAP_ROUTER", address(0));
        if (routerAddr == address(0)) return;
        IPerkGraduationManager graduation = IPerkGraduationManager(vm.parseJsonAddress(json, ".graduationManager"));
        PoolKey memory key = graduation.graduationOf(meme).key;
        PoolSwapTest(routerAddr).swap{value: 0.0005 ether}(
            key,
            SwapParams({
                zeroForOne: true, amountSpecified: -0.0005 ether, sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        console2.log("swapped 0.0005 OKB into meme");
    }

    /// @dev Linear decay runs between simulation and inclusion, so ask for 99% of what is claimable right now.
    ///      A frontend must do the same (or read `grantBreakdown` in the same block) or the call reverts ExceedsClaimable.
    function _activate(IPerkLPGrantVault vault, address meme, address deployer) internal {
        (uint256 claimable,,) = vault.grantBreakdown(meme, deployer);
        uint256 amount = (claimable * 99) / 100;
        (uint256 q, uint128 liq) = vault.quoteRequired(meme, amount);
        uint256 quoteMax = q + q / 50 + 1;
        console2.log("claimable base", claimable);
        console2.log("quote required (wei OKB)", q);
        console2.log("liquidity", liq);
        uint256 positionId = vault.activateGrant{value: quoteMax}(meme, amount, 0, 0, quoteMax, 0);
        IPerkLPGrantVault.GrantPosition memory p = vault.position(positionId);
        console2.log("position id", positionId);
        console2.log("quote deposited", p.quoteDeposited);
        console2.log("grant meme", p.grantMemeAmount);
        console2.log("vault meme balance", IERC20(meme).balanceOf(address(vault)));
    }
}
