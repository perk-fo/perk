// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

// forge-lint: disable-start(environment-read-across-mutation)

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Currency, CurrencyLibrary} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";

import {IPerkLPGrantVault} from "../../src/interfaces/IPerkLPGrantVault.sol";
import {PerkConstants} from "../../src/libraries/PerkConstants.sol";
import {PerkTypes} from "../../src/libraries/PerkTypes.sol";
import {PerkDeployer} from "./PerkDeployer.sol";
import {MerkleTree} from "./MerkleTree.sol";

/// @dev Shared LP-grant topology, actors, Merkle leaves and swap/activation helpers for edge tests.
abstract contract GrantTestBase is PerkDeployer, Deployers {
    using CurrencyLibrary for Currency;
    using PoolIdLibrary for PoolKey;

    uint256 internal constant BUY_GROSS = 200 ether;
    uint256 internal constant ALICE_BASE = 2_000_000 ether;
    uint256 internal constant BOB_BASE = 1_000_000 ether;
    uint256 internal constant BOB_BOOST = 100_000 ether;
    uint256 internal constant CAROL_BASE = 500_000 ether;

    Topology internal t;
    address internal creator = makeAddr("creator");
    address internal buyer = makeAddr("buyer");
    address internal swapper = makeAddr("swapper");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave");
    address internal eve = makeAddr("eve");
    address internal stranger = makeAddr("stranger");

    bytes32[] internal leaves;
    bytes32 internal root;

    function _setUpPerk() internal {
        _setUpPerk(10_000);
    }

    function _setUpPerk(uint16 excessToIncentiveBps) internal {
        deployFreshManagerAndRouters();
        t = deployPerkV1(address(this), address(manager), excessToIncentiveBps);
        _fundActors();
        _setDefaultLeaves();
    }

    function _fundActors() internal {
        address[9] memory who = [creator, buyer, swapper, alice, bob, carol, dave, eve, stranger];
        for (uint256 i; i < who.length; ++i) {
            vm.deal(who[i], 10_000 ether);
            t.quoteToken.mint(who[i], 10_000_000 ether);
            vm.startPrank(who[i]);
            t.quoteToken.approve(address(t.factory), type(uint256).max);
            t.quoteToken.approve(address(t.curve), type(uint256).max);
            t.quoteToken.approve(address(swapRouter), type(uint256).max);
            t.quoteToken.approve(address(t.vault), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _setDefaultLeaves() internal {
        leaves = new bytes32[](4);
        leaves[0] = MerkleTree.leaf(alice, ALICE_BASE, 0);
        leaves[1] = MerkleTree.leaf(bob, BOB_BASE, BOB_BOOST);
        leaves[2] = MerkleTree.leaf(carol, CAROL_BASE, 0);
        leaves[3] = MerkleTree.leaf(address(0xdead), 0, 0);
        root = MerkleTree.root(leaves);
    }

    function _bindBobToAlice() internal {
        vm.prank(bob);
        t.referral.bindInviter(alice);
    }

    function _graduated(Currency quote, bytes32 salt) internal returns (address meme) {
        meme = _createLaunch(PerkConstants.TEMPLATE_PERK_GRANT_V1, quote, salt);
        _buyToGraduation(meme, quote);
        t.graduation.graduate(meme);
        assertEq(uint256(t.factory.getLaunch(meme).status), uint256(PerkTypes.LaunchStatus.GRADUATED));
    }

    function _createLaunch(bytes32 templateId, Currency quote, bytes32 salt) internal returns (address meme) {
        PerkTypes.CreateLaunchParams memory p;
        p.templateId = templateId;
        p.quote = quote;
        p.metadata = PerkTypes.TokenMetadata({name: "Frog", symbol: "FROG", uri: "ipfs://frog"});
        p.salt = salt;
        vm.prank(creator);
        (,,, bytes32 configHash) = t.factory.previewLaunch(p);
        p.expectedConfigHash = configHash;
        vm.prank(creator);
        (meme,) = t.factory.createLaunch(p);
    }

    function _buyToGraduation(address meme, Currency quote) internal {
        vm.prank(buyer);
        if (quote.isAddressZero()) t.curve.buy{value: BUY_GROSS}(meme, BUY_GROSS, 0, buyer);
        else t.curve.buy(meme, BUY_GROSS, 0, buyer);
    }

    function _proposeAndActivateRoot(address meme, bytes32 merkleRoot, uint256 totalBase, uint256 totalBoost) internal {
        t.vault.proposeRoot(meme, merkleRoot, "ipfs://dataset", totalBase, totalBoost);
        vm.warp(block.timestamp + 1 days);
        t.vault.activateRoot(meme);
    }

    function _activeDefault(bytes32 salt) internal returns (address meme) {
        meme = _graduated(t.erc20Quote, salt);
        _proposeAndActivateRoot(meme, root, ALICE_BASE + BOB_BASE + CAROL_BASE, BOB_BOOST);
    }

    function _registerDefault(address meme) internal {
        t.vault.registerAllocation(meme, _leafStruct(alice, ALICE_BASE, 0), MerkleTree.proof(leaves, 0));
        t.vault.registerAllocation(meme, _leafStruct(bob, BOB_BASE, BOB_BOOST), MerkleTree.proof(leaves, 1));
        t.vault.registerAllocation(meme, _leafStruct(carol, CAROL_BASE, 0), MerkleTree.proof(leaves, 2));
    }

    function _activate(address meme, address who, uint256 base, uint256 boost, uint256 credit)
        internal
        returns (uint256 positionId)
    {
        (uint256 q,) = t.vault.quoteRequired(meme, base + boost + credit);
        uint256 quoteMax = q + q / 100 + 1;
        vm.prank(who);
        positionId = t.vault.activateGrant(meme, base, boost, credit, quoteMax, 0);
    }

    function _swap(PoolKey memory key, bool quoteIs0, uint256 amount, uint256 value) internal {
        vm.prank(swapper);
        swapRouter.swap{value: value}(
            key,
            SwapParams({
                zeroForOne: quoteIs0,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: quoteIs0 ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            bytes("")
        );
    }

    function _sellMeme(PoolKey memory key, bool quoteIs0, address meme, uint256 amount) internal {
        vm.startPrank(swapper);
        IERC20(meme).approve(address(swapRouter), type(uint256).max);
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: !quoteIs0,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: !quoteIs0 ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            bytes("")
        );
        vm.stopPrank();
    }

    function _quoteIs0(address meme) internal view returns (bool) {
        return t.erc20Quote == t.graduation.graduationOf(meme).key.currency0;
    }

    /// @dev Value of `memeAmount` in quote at the pool's current price — mirrors LPGrantVault._memeValueInQuote so
    ///      tests can check the exit settlement independently of the contract's own arithmetic.
    function _memeValueInQuote(address meme, uint256 memeAmount) internal view returns (uint256) {
        if (memeAmount == 0) return 0;
        PoolId id = t.graduation.graduationOf(meme).key.toId();
        (uint160 sqrtP,,,) = StateLibrary.getSlot0(manager, id);
        uint256 q96 = 1 << 96;
        if (t.vault.campaign(meme).memeIsCurrency0) {
            return Math.mulDiv(Math.mulDiv(memeAmount, sqrtP, q96), sqrtP, q96);
        }
        return Math.mulDiv(Math.mulDiv(memeAmount, q96, sqrtP), q96, sqrtP);
    }

    function _leafStruct(address a, uint256 b, uint256 boost)
        internal
        pure
        returns (IPerkLPGrantVault.GrantLeaf memory)
    {
        return IPerkLPGrantVault.GrantLeaf({account: a, baseAllocation: b, inviteeBoost: boost});
    }

    function _defaultTotalBase() internal pure returns (uint256) {
        return ALICE_BASE + BOB_BASE + CAROL_BASE;
    }
}
// forge-lint: disable-end(environment-read-across-mutation)
