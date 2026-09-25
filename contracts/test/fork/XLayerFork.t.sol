// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Currency, CurrencyLibrary} from "v4-core/src/types/Currency.sol";

import {IPerkGraduationManager} from "../../src/interfaces/IPerkGraduationManager.sol";
import {IPerkHolderRewardDistributor} from "../../src/interfaces/IPerkHolderRewardDistributor.sol";
import {PerkTypes} from "../../src/libraries/PerkTypes.sol";
import {XLayerAddresses} from "../../script/lib/XLayerAddresses.sol";
import {ForkBase} from "./ForkBase.sol";

interface IOwnableView {
    function owner() external view returns (address);
}

contract XLayerForkTest is ForkBase {
    using CurrencyLibrary for Currency;

    uint256 internal gasCreateLaunch;
    uint256 internal gasBuy;
    uint256 internal gasGraduate;
    uint256 internal gasSwap;

    /// @notice Canonical PoolManager has runtime code and `owner()` responds.
    function test_poolManager_hasCodeAndOwner() public view {
        address pm = XLayerAddresses.POOL_MANAGER;
        assertGt(pm.code.length, 0);
        assertGt(XLayerAddresses.POSITION_MANAGER.code.length, 0);
        assertTrue(IOwnableView(pm).owner() != address(0));
        IPoolManager(pm).protocolFeeController();
        assertEq(t.poolManager, pm);
        assertEq(address(t.positionManager), XLayerAddresses.POSITION_MANAGER);
    }

    /// @notice Native OKB: createLaunch → buy to graduation → graduate → swap on the official PoolManager.
    function test_createLaunch_nativeOkb_buyGraduateSwap() public {
        _runFlow(t.nativeQuote, keccak256("fork-okb"), true);
    }

    /// @notice ERC-20 quote when `INITIAL_QUOTE_TOKEN` is set; skipped otherwise.
    function test_createLaunch_erc20Quote_buyGraduateSwap() public {
        address erc20 = _initialQuoteToken();
        if (erc20 == address(0)) {
            vm.skip(true);
            return;
        }
        _runFlow(Currency.wrap(erc20), keccak256("fork-erc20"), false);
    }

    function _runFlow(Currency quote, bytes32 salt, bool logGas) internal {
        (address meme, uint256 createGas) = _createLaunch(quote, salt);
        if (logGas) gasCreateLaunch = createGas;

        uint256 buyGas = _buyToGraduation(meme, quote);
        if (logGas) gasBuy = buyGas;
        assertEq(uint256(t.factory.getLaunch(meme).status), uint256(PerkTypes.LaunchStatus.GRADUATION_PENDING));

        vm.startSnapshotGas("fork_graduate");
        t.graduation.graduate(meme);
        uint256 graduateGas = vm.stopSnapshotGas();
        if (logGas) gasGraduate = graduateGas;

        IPerkGraduationManager.Graduation memory g = t.graduation.graduationOf(meme);
        assertEq(uint256(g.stage), uint256(IPerkGraduationManager.Stage.DONE));
        assertEq(uint256(t.factory.getLaunch(meme).status), uint256(PerkTypes.LaunchStatus.GRADUATED));
        assertTrue(t.hook.poolInfo(g.poolId).initialized);

        uint256 routerBefore = quote.balanceOf(address(t.feeRouter));
        uint256 accBefore = t.distributor.rewardState(meme).accQuotePerShare;

        uint256 swapGas = _swapQuoteIn(g.key, quote, SWAP_IN);
        if (logGas) gasSwap = swapGas;

        assertGt(quote.balanceOf(address(t.feeRouter)), routerBefore);
        IPerkHolderRewardDistributor.MemeRewardState memory rs = t.distributor.rewardState(meme);
        assertGt(rs.accQuotePerShare, accBefore);

        if (logGas) {
            emit log_named_uint("fork_createLaunch", gasCreateLaunch);
            emit log_named_uint("fork_buy", gasBuy);
            emit log_named_uint("fork_graduate", gasGraduate);
            emit log_named_uint("fork_swap", gasSwap);
        }
    }
}
