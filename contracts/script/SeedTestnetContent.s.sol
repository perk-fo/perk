// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

import {PerkTypes} from "../src/libraries/PerkTypes.sol";
import {PerkTemplates} from "../src/libraries/PerkTemplates.sol";
import {IPerkLaunchFactory} from "../src/interfaces/IPerkLaunchFactory.sol";
import {IPerkBondingCurve} from "../src/interfaces/IPerkBondingCurve.sol";
import {IPerkGraduationManager} from "../src/interfaces/IPerkGraduationManager.sol";

/// @notice Testnet-only content seeding for the web app: one native launch left mid-curve (partial dev buy) and one
///         launch quoted in the mock tokenized stock, bought to graduation and graduated. Uses TEST_TEMPLATE.
contract SeedTestnetContent is Script {
    function run() external {
        require(block.chainid != 196, "testnet only");
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        string memory json =
            vm.readFile(string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json"));
        IPerkLaunchFactory factory = IPerkLaunchFactory(vm.parseJsonAddress(json, ".factory"));
        IPerkBondingCurve curve = IPerkBondingCurve(vm.parseJsonAddress(json, ".curve"));
        IPerkGraduationManager graduation = IPerkGraduationManager(vm.parseJsonAddress(json, ".graduationManager"));
        address stock = vm.parseJsonAddress(json, ".quoteAssets.tAAPL");
        bytes32 fast = keccak256(bytes(vm.envOr("TEST_TEMPLATE", string("TEST_FAST_V1"))));

        vm.startBroadcast(pk);

        // 1. native OKB, mid-curve: threshold 0.0085 OKB, dev buy 0.0035 gross (~40%)
        address memeA =
            _create(factory, fast, Currency.wrap(address(0)), "Ledger Frog", "LFROG", 0.0035 ether, 0.0035 ether);
        console2.log("curve-stage native meme", memeA);
        console2.log("  progress bps", curve.progressBps(memeA));

        // 2. tokenized-stock quote, graduated: threshold 0.0085 tAAPL (8500 units), dev buy 0.02 tAAPL
        bytes32 stockTemplate = PerkTemplates.templateIdFor(fast, Currency.wrap(stock));
        IERC20(stock).approve(address(factory), type(uint256).max);
        address memeB = _create(factory, stockTemplate, Currency.wrap(stock), "Apple Sauce", "SAUCE", 20_000, 0);
        graduation.graduate(memeB);
        console2.log("graduated tAAPL meme", memeB);
        console2.log("  status (3 = GRADUATED)", uint256(factory.getLaunch(memeB).status));
        console2.log("  deployer tAAPL balance", IERC20(stock).balanceOf(deployer));

        vm.stopBroadcast();
    }

    function _create(
        IPerkLaunchFactory factory,
        bytes32 templateId,
        Currency quote,
        string memory name,
        string memory symbol,
        uint256 devBuy,
        uint256 value
    ) internal returns (address meme) {
        PerkTypes.CreateLaunchParams memory p = PerkTypes.CreateLaunchParams({
            templateId: templateId,
            quote: quote,
            moduleParams: "",
            expectedConfigHash: bytes32(0),
            metadata: PerkTypes.TokenMetadata({name: name, symbol: symbol, uri: string.concat("ipfs://", symbol)}),
            devBuyQuote: devBuy,
            salt: keccak256(abi.encode(symbol, block.timestamp))
        });
        (,,, bytes32 configHash) = factory.previewLaunch(p);
        p.expectedConfigHash = configHash;
        (meme,) = factory.createLaunch{value: value}(p);
    }
}
