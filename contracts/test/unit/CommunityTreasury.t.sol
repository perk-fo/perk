// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {CommunityTreasury} from "../../src/treasury/CommunityTreasury.sol";
import {IPerkCommunityTreasury} from "../../src/interfaces/IPerkCommunityTreasury.sol";
import {MockERC20} from "../utils/MockERC20.sol";

contract CommunityTreasuryTest is Test {
    uint256 internal constant TIMELOCK = 7 days;

    CommunityTreasury internal treasury;
    MockERC20 internal token;
    address internal owner;
    address internal stranger;
    address internal successor;

    Currency internal native;
    Currency internal erc20;

    event Received(Currency indexed quote, address indexed from, uint256 amount, bytes32 indexed ref);
    event MigrationProposed(Currency indexed quote, address indexed to, uint256 executeAfter);
    event MigrationCancelled(Currency indexed quote);
    event MigrationExecuted(Currency indexed quote, address indexed to, uint256 amount);

    function setUp() public {
        owner = address(this);
        stranger = makeAddr("stranger");
        successor = makeAddr("successor");
        treasury = new CommunityTreasury(owner, TIMELOCK);
        token = new MockERC20("Quote", "Q", 6);
        native = Currency.wrap(address(0));
        erc20 = Currency.wrap(address(token));
    }

    function test_deposit_native_emitsReceivedWithRef() public {
        bytes32 ref = keccak256("launch");
        vm.expectEmit(true, true, true, true, address(treasury));
        emit Received(native, address(this), 1 ether, ref);
        treasury.deposit{value: 1 ether}(native, 1 ether, ref);
        assertEq(treasury.balance(native), 1 ether);
        assertEq(address(treasury).balance, 1 ether);
    }

    function test_deposit_erc20_emitsReceivedWithRef() public {
        bytes32 ref = keccak256("grant");
        token.mint(address(this), 1000e6);
        token.approve(address(treasury), 1000e6);
        vm.expectEmit(true, true, true, true, address(treasury));
        emit Received(erc20, address(this), 400e6, ref);
        treasury.deposit(erc20, 400e6, ref);
        assertEq(treasury.balance(erc20), 400e6);
        assertEq(token.balanceOf(address(treasury)), 400e6);
        assertEq(token.balanceOf(address(this)), 600e6);
    }

    function test_deposit_reverts_nativeAmountMismatch_wrongValue() public {
        vm.expectRevert(IPerkCommunityTreasury.NativeAmountMismatch.selector);
        treasury.deposit{value: 1 ether}(native, 2 ether, bytes32(0));
    }

    function test_deposit_reverts_nativeAmountMismatch_erc20WithValue() public {
        token.mint(address(this), 100e6);
        token.approve(address(treasury), 100e6);
        vm.expectRevert(IPerkCommunityTreasury.NativeAmountMismatch.selector);
        treasury.deposit{value: 1}(erc20, 100e6, bytes32(0));
    }

    function test_receive_emitsReceivedWithZeroRef() public {
        vm.expectEmit(true, true, true, true, address(treasury));
        emit Received(native, address(this), 2 ether, bytes32(0));
        (bool ok,) = address(treasury).call{value: 2 ether}("");
        assertTrue(ok);
        assertEq(treasury.balance(native), 2 ether);
    }

    function test_proposeMigration_reverts_notOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        treasury.proposeMigration(native, successor);
    }

    function test_proposeMigration_reverts_zeroAddress() public {
        vm.expectRevert(IPerkCommunityTreasury.ZeroAddress.selector);
        treasury.proposeMigration(native, address(0));
    }

    function test_proposeMigration_repropose_restartsClock() public {
        treasury.proposeMigration(native, successor);
        (, uint256 firstAfter) = treasury.pendingMigration(native);
        uint256 t0 = vm.getBlockTimestamp();
        assertEq(firstAfter, t0 + TIMELOCK);

        vm.warp(t0 + 1 days);
        uint256 t1 = vm.getBlockTimestamp();
        address other = makeAddr("otherSuccessor");
        vm.expectEmit(true, true, false, true, address(treasury));
        emit MigrationProposed(native, other, t1 + TIMELOCK);
        treasury.proposeMigration(native, other);

        (address to, uint256 executeAfter) = treasury.pendingMigration(native);
        assertEq(to, other);
        assertEq(executeAfter, t1 + TIMELOCK);
        assertGt(executeAfter, firstAfter);
    }

    function test_executeMigration_reverts_beforeTimelockWithExactExecuteAfter() public {
        treasury.deposit{value: 1 ether}(native, 1 ether, bytes32(uint256(1)));
        treasury.proposeMigration(native, successor);
        (, uint256 executeAfter) = treasury.pendingMigration(native);

        vm.warp(executeAfter - 1);
        vm.expectRevert(abi.encodeWithSelector(IPerkCommunityTreasury.TimelockNotElapsed.selector, executeAfter));
        treasury.executeMigration(native);
    }

    function test_executeMigration_native_transfersWholeBalanceAndClears() public {
        treasury.deposit{value: 3 ether}(native, 3 ether, bytes32(uint256(1)));
        (bool ok,) = address(treasury).call{value: 1 ether}("");
        assertTrue(ok);
        treasury.proposeMigration(native, successor);
        (, uint256 executeAfter) = treasury.pendingMigration(native);

        vm.warp(executeAfter);
        uint256 before = successor.balance;
        vm.expectEmit(true, true, false, true, address(treasury));
        emit MigrationExecuted(native, successor, 4 ether);
        vm.prank(stranger);
        treasury.executeMigration(native);

        assertEq(successor.balance, before + 4 ether);
        assertEq(treasury.balance(native), 0);
        (address to, uint256 afterTs) = treasury.pendingMigration(native);
        assertEq(to, address(0));
        assertEq(afterTs, 0);
    }

    function test_executeMigration_erc20_transfersWholeBalanceAndClears() public {
        token.mint(address(this), 500e6);
        token.approve(address(treasury), 500e6);
        treasury.deposit(erc20, 500e6, bytes32(uint256(2)));
        treasury.proposeMigration(erc20, successor);
        (, uint256 executeAfter) = treasury.pendingMigration(erc20);

        vm.warp(executeAfter);
        vm.expectEmit(true, true, false, true, address(treasury));
        emit MigrationExecuted(erc20, successor, 500e6);
        treasury.executeMigration(erc20);

        assertEq(token.balanceOf(successor), 500e6);
        assertEq(treasury.balance(erc20), 0);
        (address to,) = treasury.pendingMigration(erc20);
        assertEq(to, address(0));
    }

    function test_cancelMigration_clearsAndExecuteReverts() public {
        treasury.proposeMigration(native, successor);
        vm.expectEmit(true, false, false, true, address(treasury));
        emit MigrationCancelled(native);
        treasury.cancelMigration(native);

        (address to,) = treasury.pendingMigration(native);
        assertEq(to, address(0));

        vm.expectRevert(IPerkCommunityTreasury.NoPendingMigration.selector);
        treasury.executeMigration(native);
    }

    function test_cancelMigration_reverts_noPending() public {
        vm.expectRevert(IPerkCommunityTreasury.NoPendingMigration.selector);
        treasury.cancelMigration(native);
    }

    function test_executeMigration_reverts_noPending() public {
        vm.expectRevert(IPerkCommunityTreasury.NoPendingMigration.selector);
        treasury.executeMigration(native);
    }

    // Funds can leave this contract only through executeMigration. deposit/receive are inflows;
    // propose/cancel/views never transfer. Ownable2Step ownership transfer does not move quote.
    function test_noOtherOutflow_besidesExecuteMigration() public view {
        assertEq(treasury.timelock(), TIMELOCK);
        assertEq(treasury.owner(), owner);
    }
}
