// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";

import {IPerkLaunchFactory} from "../../src/interfaces/IPerkLaunchFactory.sol";
import {IPerkLPGrantVault} from "../../src/interfaces/IPerkLPGrantVault.sol";
import {PerkConstants} from "../../src/libraries/PerkConstants.sol";
import {PerkTypes} from "../../src/libraries/PerkTypes.sol";
import {GrantTestBase} from "../utils/GrantTestBase.sol";
import {MerkleTree} from "../utils/MerkleTree.sol";

/// @notice The core admin's emergency pause (entry points only) and the separate grant publisher role.
contract EmergencyControlsTest is GrantTestBase {
    address internal publisherKey = makeAddr("publisher");

    function setUp() public {
        _setUpPerk();
    }

    function _paused(uint256 area) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IPerkLaunchFactory.Paused.selector, area);
    }

    // ================================================================== pause: who and what

    function test_setPaused_ownerOnly_knownAreasOnly_emits() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        t.factory.setPaused(PerkConstants.PAUSE_ALL);

        vm.expectRevert(abi.encodeWithSelector(IPerkLaunchFactory.UnknownPauseArea.selector, uint256(1 << 4)));
        t.factory.setPaused(1 << 4);

        vm.expectEmit(false, false, false, true, address(t.factory));
        emit IPerkLaunchFactory.PauseUpdated(PerkConstants.PAUSE_BUY);
        t.factory.setPaused(PerkConstants.PAUSE_BUY);
        assertTrue(t.factory.isPaused(PerkConstants.PAUSE_BUY));
        assertFalse(t.factory.isPaused(PerkConstants.PAUSE_LAUNCH));
        t.factory.setPaused(0);
        assertEq(t.factory.pausedFlags(), 0);
    }

    function test_pauseLaunch_blocksNewLaunchesOnly_andResumes() public {
        address existing = _createLaunch(PerkConstants.TEMPLATE_PERK_GRANT_V1, t.erc20Quote, keccak256("before"));
        t.factory.setPaused(PerkConstants.PAUSE_LAUNCH);

        PerkTypes.CreateLaunchParams memory p;
        p.templateId = PerkConstants.TEMPLATE_PERK_GRANT_V1;
        p.quote = t.erc20Quote;
        p.metadata = PerkTypes.TokenMetadata({name: "Late", symbol: "LATE", uri: "ipfs://late"});
        p.salt = keccak256("during");
        vm.prank(creator);
        (,,, bytes32 configHash) = t.factory.previewLaunch(p); // previews still work
        p.expectedConfigHash = configHash;
        vm.prank(creator);
        vm.expectRevert(_paused(PerkConstants.PAUSE_LAUNCH));
        t.factory.createLaunch(p);

        vm.prank(alice); // trading the launches that already exist is untouched
        t.curve.buy(existing, 1 ether, 0, alice);

        t.factory.setPaused(0);
        vm.prank(creator);
        t.factory.createLaunch(p);
    }

    function test_pauseBuy_blocksBuying_sellingStillWorks() public {
        address meme = _createLaunch(PerkConstants.TEMPLATE_PERK_GRANT_V1, t.erc20Quote, keccak256("buy"));
        vm.prank(alice);
        t.curve.buy(meme, 5 ether, 0, alice);

        t.factory.setPaused(PerkConstants.PAUSE_BUY);
        vm.prank(alice);
        vm.expectRevert(_paused(PerkConstants.PAUSE_BUY));
        t.curve.buy(meme, 1 ether, 0, alice);

        uint256 bal = IERC20(meme).balanceOf(alice);
        uint256 before = t.erc20Quote.balanceOf(alice);
        vm.startPrank(alice);
        IERC20(meme).approve(address(t.curve), bal);
        t.curve.sell(meme, bal, 0, alice);
        vm.stopPrank();
        assertGt(t.erc20Quote.balanceOf(alice), before, "a paused buy side never traps a holder");
    }

    function test_pauseGraduation_holdsGraduation_thenResumes() public {
        address meme = _createLaunch(PerkConstants.TEMPLATE_PERK_GRANT_V1, t.erc20Quote, keccak256("grad"));
        _buyToGraduation(meme, t.erc20Quote);
        t.factory.setPaused(PerkConstants.PAUSE_GRADUATION);
        vm.expectRevert(_paused(PerkConstants.PAUSE_GRADUATION));
        t.graduation.graduate(meme);
        t.factory.setPaused(0);
        t.graduation.graduate(meme);
        assertEq(uint256(t.factory.getLaunch(meme).status), uint256(PerkTypes.LaunchStatus.GRADUATED));
    }

    function test_pauseGrantJoin_blocksNewPositions_existingOnesCanLeave() public {
        address meme = _activeDefault(keccak256("join"));
        _registerDefault(meme);
        uint256 pos = _activate(meme, alice, ALICE_BASE, 0, 0);

        t.factory.setPaused(PerkConstants.PAUSE_GRANT_JOIN);
        (uint256 q,) = t.vault.quoteRequired(meme, BOB_BASE);
        vm.prank(bob);
        vm.expectRevert(_paused(PerkConstants.PAUSE_GRANT_JOIN));
        t.vault.activateGrant(meme, BOB_BASE, 0, 0, q + q / 100 + 1, 0);

        vm.warp(block.timestamp + 1 days + 1);
        t.vault.collectGrantFees(pos);
        vm.prank(alice);
        (uint256 toUser,,,) = t.vault.exitGrantPosition(pos, 0, 0);
        assertGt(toUser, 0, "a paused grant never traps a position");
    }

    /// @dev The design rule in one test: with every area paused, every way out still works.
    function test_pauseAll_everyExitStillWorks() public {
        // a curve launch alice holds, and a graduated launch with a grant position, pool trading and fees
        address onCurve = _createLaunch(PerkConstants.TEMPLATE_PERK_GRANT_V1, t.erc20Quote, keccak256("curve"));
        vm.prank(alice);
        t.curve.buy(onCurve, 5 ether, 0, alice);
        address meme = _activeDefault(keccak256("all"));
        _registerDefault(meme);
        uint256 pos = _activate(meme, alice, ALICE_BASE, 0, 0);
        PoolKey memory key = t.graduation.graduationOf(meme).key;
        _swap(key, _quoteIs0(meme), 5 ether, 0);

        t.factory.setPaused(PerkConstants.PAUSE_ALL);

        // curve sell
        uint256 bal = IERC20(onCurve).balanceOf(alice);
        vm.startPrank(alice);
        IERC20(onCurve).approve(address(t.curve), bal);
        t.curve.sell(onCurve, bal, 0, alice);
        vm.stopPrank();
        // pool swaps both ways (the hook has no pause)
        _swap(key, _quoteIs0(meme), 1 ether, 0);
        _sellMeme(key, _quoteIs0(meme), meme, IERC20(meme).balanceOf(swapper) / 10);
        // fee and reward claims
        t.feeRouter.claimDevFees(meme);
        t.feeRouter.claimProtocolFees(t.erc20Quote);
        t.feeRouter.pushTreasuryFees(meme);
        vm.prank(buyer);
        t.distributor.claimQuoteRewards(meme);
        // grant fees and exit
        vm.warp(block.timestamp + 1 days + 1);
        t.vault.collectGrantFees(pos);
        vm.prank(alice);
        t.vault.exitGrantPosition(pos, 0, 0);
        assertTrue(t.vault.position(pos).exited);
    }

    // ================================================================== grant publisher

    function test_setPublisher_ownerOnly_emits() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        t.vault.setPublisher(stranger);

        vm.expectEmit(true, true, false, false, address(t.vault));
        emit IPerkLPGrantVault.PublisherUpdated(address(0), publisherKey);
        t.vault.setPublisher(publisherKey);
        assertEq(t.vault.publisher(), publisherKey);
    }

    function test_publisher_proposesAndCancels_strangerCannot() public {
        t.vault.setPublisher(publisherKey);
        address meme = _graduated(t.erc20Quote, keccak256("pub"));

        vm.prank(stranger);
        vm.expectRevert(IPerkLPGrantVault.NotPublisher.selector);
        t.vault.proposeRoot(meme, root, "ipfs://dataset", _defaultTotalBase(), BOB_BOOST);

        vm.prank(publisherKey);
        t.vault.proposeRoot(meme, root, "ipfs://dataset", _defaultTotalBase(), BOB_BOOST);
        assertEq(uint256(t.vault.campaign(meme).status), uint256(IPerkLPGrantVault.CampaignStatus.ROOT_PROPOSED));

        vm.prank(stranger);
        vm.expectRevert(IPerkLPGrantVault.NotPublisher.selector);
        t.vault.cancelRoot(meme);
        vm.prank(publisherKey);
        t.vault.cancelRoot(meme);
        assertEq(uint256(t.vault.campaign(meme).status), uint256(IPerkLPGrantVault.CampaignStatus.AWAITING_ROOT));
    }

    /// @dev The publisher key is meant to live on a server, so it must be good for nothing else.
    function test_publisher_hasNoOtherPower() public {
        t.vault.setPublisher(publisherKey);
        address pending = _createLaunch(PerkConstants.TEMPLATE_PERK_GRANT_V1, t.erc20Quote, keccak256("power"));
        _buyToGraduation(pending, t.erc20Quote);
        bytes memory notOwner = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, publisherKey);

        vm.startPrank(publisherKey);
        vm.expectRevert(notOwner);
        t.vault.setPublisher(publisherKey);
        vm.expectRevert(notOwner);
        t.factory.setPaused(PerkConstants.PAUSE_ALL);
        vm.expectRevert(notOwner);
        t.graduation.proposeRescue(pending);
        vm.expectRevert(notOwner);
        t.assetRegistry
            .setAsset(
                t.erc20Quote,
                PerkTypes.AssetInfo({
                    enabled: false, rewardCompatible: false, isNative: false, decimals: 18, symbol: "X"
                })
            );
        vm.expectRevert(notOwner);
        t.treasury.proposeMigration(t.erc20Quote, publisherKey);
        vm.stopPrank();
    }

    /// @dev The owner stays able to publish (the fallback while no publisher is set) and to cancel a root the
    ///      publisher got wrong during its review window.
    function test_owner_stillPublishes_andCancelsThePublishersRoot() public {
        address meme = _graduated(t.erc20Quote, keccak256("fallback"));
        t.vault.proposeRoot(meme, root, "ipfs://dataset", _defaultTotalBase(), BOB_BOOST);
        t.vault.cancelRoot(meme);

        t.vault.setPublisher(publisherKey);
        bytes32 wrongRoot = MerkleTree.root(leaves); // any root: the point is who may withdraw it
        vm.prank(publisherKey);
        t.vault.proposeRoot(meme, wrongRoot, "ipfs://wrong", _defaultTotalBase(), BOB_BOOST);
        vm.expectEmit(true, false, false, true, address(t.vault));
        emit IPerkLPGrantVault.GrantRootCancelled(meme, wrongRoot);
        t.vault.cancelRoot(meme);

        t.vault.setPublisher(address(0)); // revoking leaves publishing to the owner
        vm.prank(publisherKey);
        vm.expectRevert(IPerkLPGrantVault.NotPublisher.selector);
        t.vault.proposeRoot(meme, root, "ipfs://dataset", _defaultTotalBase(), BOB_BOOST);
    }

    // ================================================================== refunding status

    /// @dev Only the graduation manager can move a launch to REFUNDING, and only from GRADUATION_PENDING.
    function test_factory_refundingOnlyFromPending_byGraduationManager() public {
        address active = _createLaunch(PerkConstants.TEMPLATE_PERK_GRANT_V1, t.erc20Quote, keccak256("st-active"));
        vm.prank(address(t.graduation));
        vm.expectRevert(IPerkLaunchFactory.InvalidStatusTransition.selector);
        t.factory.setLaunchStatus(active, PerkTypes.LaunchStatus.REFUNDING, PoolId.wrap(bytes32(0)));

        address pending = _createLaunch(PerkConstants.TEMPLATE_PERK_GRANT_V1, t.erc20Quote, keccak256("st-pend"));
        _buyToGraduation(pending, t.erc20Quote);
        vm.prank(address(t.curve));
        vm.expectRevert(IPerkLaunchFactory.InvalidStatusTransition.selector);
        t.factory.setLaunchStatus(pending, PerkTypes.LaunchStatus.REFUNDING, PoolId.wrap(bytes32(0)));
        vm.prank(stranger);
        vm.expectRevert(IPerkLaunchFactory.NotStatusUpdater.selector);
        t.factory.setLaunchStatus(pending, PerkTypes.LaunchStatus.REFUNDING, PoolId.wrap(bytes32(0)));
        vm.prank(address(t.graduation));
        vm.expectRevert(IPerkLaunchFactory.InvalidStatusTransition.selector);
        t.factory.setLaunchStatus(pending, PerkTypes.LaunchStatus.CURVE_ACTIVE, PoolId.wrap(bytes32(0)));
        vm.prank(address(t.graduation));
        t.factory.setLaunchStatus(pending, PerkTypes.LaunchStatus.REFUNDING, PoolId.wrap(bytes32(0)));

        address done = _graduated(t.erc20Quote, keccak256("st-done"));
        vm.prank(address(t.graduation));
        vm.expectRevert(IPerkLaunchFactory.InvalidStatusTransition.selector);
        t.factory.setLaunchStatus(done, PerkTypes.LaunchStatus.REFUNDING, PoolId.wrap(bytes32(0)));
    }
}
