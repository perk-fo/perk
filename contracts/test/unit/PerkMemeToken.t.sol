// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {PerkMemeToken} from "../../src/token/PerkMemeToken.sol";

contract RecordingDistributor {
    struct Checkpoint {
        address account;
        uint256 oldBalance;
        uint256 newBalance;
    }

    Checkpoint[] public checkpoints;

    function onBalanceChange(address account, uint256 oldBalance, uint256 newBalance) external {
        checkpoints.push(Checkpoint(account, oldBalance, newBalance));
    }

    function count() external view returns (uint256) {
        return checkpoints.length;
    }
}

contract RevertingDistributor {
    function onBalanceChange(address, uint256, uint256) external pure {
        revert();
    }
}

contract GassyCustomErrorDistributor {
    error GassyBoom();

    function onBalanceChange(address, uint256, uint256) external pure {
        uint256 n;
        unchecked {
            while (n < 25_000) {
                ++n;
            }
        }
        revert GassyBoom();
    }
}

contract PerkMemeTokenTest is Test {
    uint256 internal constant TOTAL_SUPPLY = 1_000_000 ether;
    string internal constant URI = "ipfs://perk-meme";

    event RewardCheckpointFailed(address indexed account, uint256 oldBalance, uint256 newBalance);

    RecordingDistributor internal recorder;
    PerkMemeToken internal token;

    function setUp() public {
        recorder = new RecordingDistributor();
        token = new PerkMemeToken("Perk Meme", "PERK", URI, TOTAL_SUPPLY, address(recorder));
    }

    function test_constructor_mintsToDeployerAndSetsMetadata() public view {
        assertEq(token.name(), "Perk Meme");
        assertEq(token.symbol(), "PERK");
        assertEq(token.decimals(), 18);
        assertEq(token.totalSupply(), TOTAL_SUPPLY);
        assertEq(token.balanceOf(address(this)), TOTAL_SUPPLY);
        assertEq(token.factory(), address(this));
        assertEq(token.distributor(), address(recorder));
        assertEq(token.tokenURI(), URI);
    }

    function test_constructor_checkpointsMintToFactory() public view {
        assertEq(recorder.count(), 1);
        (address account, uint256 oldBalance, uint256 newBalance) = recorder.checkpoints(0);
        assertEq(account, address(this));
        assertEq(oldBalance, 0);
        assertEq(newBalance, TOTAL_SUPPLY);
    }

    function test_transfer_callsDistributorTwiceWithOldAndNewBalances() public {
        address to = makeAddr("alice");
        uint256 amount = 100 ether;
        uint256 fromOld = token.balanceOf(address(this));
        uint256 toOld = token.balanceOf(to);
        uint256 beforeCount = recorder.count();

        token.transfer(to, amount);

        assertEq(recorder.count(), beforeCount + 2);

        (address fromAccount, uint256 recordedFromOld, uint256 recordedFromNew) = recorder.checkpoints(beforeCount);
        assertEq(fromAccount, address(this));
        assertEq(recordedFromOld, fromOld);
        assertEq(recordedFromNew, fromOld - amount);

        (address toAccount, uint256 recordedToOld, uint256 recordedToNew) = recorder.checkpoints(beforeCount + 1);
        assertEq(toAccount, to);
        assertEq(recordedToOld, toOld);
        assertEq(recordedToNew, toOld + amount);
    }

    function test_transfer_selfTransfer_callsDistributorOnce() public {
        uint256 amount = 10 ether;
        uint256 beforeCount = recorder.count();
        uint256 oldBalance = token.balanceOf(address(this));

        token.transfer(address(this), amount);

        assertEq(recorder.count(), beforeCount + 1);
        (address account, uint256 recordedOld, uint256 recordedNew) = recorder.checkpoints(beforeCount);
        assertEq(account, address(this));
        assertEq(recordedOld, oldBalance);
        assertEq(recordedNew, oldBalance);
        assertEq(token.balanceOf(address(this)), oldBalance);
    }

    function test_burn_callsDistributorOnceAndDecreasesTotalSupply() public {
        uint256 amount = 25 ether;
        uint256 beforeCount = recorder.count();
        uint256 oldBalance = token.balanceOf(address(this));
        uint256 oldSupply = token.totalSupply();

        token.burn(amount);

        assertEq(token.totalSupply(), oldSupply - amount);
        assertEq(token.balanceOf(address(this)), oldBalance - amount);
        assertEq(recorder.count(), beforeCount + 1);

        (address account, uint256 recordedOld, uint256 recordedNew) = recorder.checkpoints(beforeCount);
        assertEq(account, address(this));
        assertEq(recordedOld, oldBalance);
        assertEq(recordedNew, oldBalance - amount);
    }

    function test_transfer_revertingDistributor_stillSucceedsAndEmitsFailed() public {
        RevertingDistributor reverting = new RevertingDistributor();
        PerkMemeToken noisy = new PerkMemeToken("Noisy", "NOY", URI, TOTAL_SUPPLY, address(reverting));
        address to = makeAddr("bob");
        uint256 amount = 7 ether;
        uint256 fromOld = noisy.balanceOf(address(this));

        vm.expectEmit(true, false, false, true, address(noisy));
        emit RewardCheckpointFailed(address(this), fromOld, fromOld - amount);
        vm.expectEmit(true, false, false, true, address(noisy));
        emit RewardCheckpointFailed(to, 0, amount);

        bool ok = noisy.transfer(to, amount);
        assertTrue(ok);
        assertEq(noisy.balanceOf(to), amount);
        assertEq(noisy.balanceOf(address(this)), fromOld - amount);
    }

    function test_transfer_gassyCustomErrorDistributor_stillSucceeds() public {
        GassyCustomErrorDistributor gassy = new GassyCustomErrorDistributor();
        PerkMemeToken noisy = new PerkMemeToken("Gassy", "GAS", URI, TOTAL_SUPPLY, address(gassy));
        address to = makeAddr("carol");
        uint256 amount = 3 ether;

        vm.expectEmit(true, false, false, true, address(noisy));
        emit RewardCheckpointFailed(address(this), TOTAL_SUPPLY, TOTAL_SUPPLY - amount);
        vm.expectEmit(true, false, false, true, address(noisy));
        emit RewardCheckpointFailed(to, 0, amount);

        bool ok = noisy.transfer(to, amount);
        assertTrue(ok);
        assertEq(noisy.balanceOf(to), amount);
    }

    function testFuzz_transfer_sumOfBalancesEqualsTotalSupply(uint256[8] memory amounts) public {
        address[4] memory holders;
        holders[0] = address(this);
        holders[1] = makeAddr("h1");
        holders[2] = makeAddr("h2");
        holders[3] = makeAddr("h3");

        for (uint256 i; i < amounts.length; ++i) {
            address from = holders[i % holders.length];
            address to = holders[(i + 1) % holders.length];
            uint256 fromBal = token.balanceOf(from);
            if (fromBal == 0) continue;
            uint256 amount = bound(amounts[i], 0, fromBal);
            if (amount == 0) continue;
            vm.prank(from);
            token.transfer(to, amount);
        }

        uint256 sum;
        for (uint256 i; i < holders.length; ++i) {
            sum += token.balanceOf(holders[i]);
        }
        assertEq(sum, token.totalSupply());
        assertEq(token.totalSupply(), TOTAL_SUPPLY);
    }
}
