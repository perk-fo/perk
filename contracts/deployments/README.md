# Deployments

JSON artifacts written by `DeployPerk.s.sol` via `vm.writeJson`. One file per chain: `<chainId>.json`.

Do not hand-edit these files. Re-run the script to refresh them.

## Addresses on X Layer mainnet (196)

Canonical Uniswap v4 contracts live in `script/lib/XLayerAddresses.sol`. Testnet (1952) and local anvil have no official v4: leave `V4_TESTNET_POOL_MANAGER` empty and `DeployPerk` will run `DeployTestnetV4` first (v4-core BUSL, non-production).

## How to run

From `contracts/`, with env loaded:

```
../scripts/with-env.sh forge script script/DeployPerk.s.sol --rpc-url xlayer_testnet --broadcast --verify
../scripts/with-env.sh forge script script/ConfigurePerk.s.sol --rpc-url xlayer_testnet --broadcast --verify
```

Mainnet: `--rpc-url xlayer`. RPC URLs and explorer settings come from `foundry.toml` (`ALCHEMY_API_KEY`, `XLAYER_EXPLORER_API_KEY`).

Optional env (see repo `.env.example`):

- `DEPLOYER_PRIVATE_KEY` (required)
- `PROTOCOL_OWNER` / `PROTOCOL_FEE_RECIPIENT` (default: deployer)
- `TREASURY_TIMELOCK_SECONDS` (default: 172800)
- `XDOG_TOKEN_ADDRESS` (mainnet: set before launch; testnet: mock XDOG is deployed when empty)
- `V4_TESTNET_POOL_MANAGER` / `V4_TESTNET_POSITION_MANAGER`
- `GIT_COMMIT` (recorded in the JSON; default `unknown`)

## After ConfigurePerk

`ConfigurePerk` calls `transferOwnership` (Ownable2Step) on every owned contract. `PROTOCOL_OWNER` must then `acceptOwnership()` on:

- TemplateRegistry
- ModuleRegistry
- AssetRegistry
- CommunityTreasury
- LaunchFactory
- FeeRouter
- GraduationManager
- GrantReserveEscrow

`PERK_GRANT_V1` and `STANDARD_CURVE_V1` are registered from `PerkTemplates.defaultNumbers()`. Those numbers are placeholders.

## JSON keys

`chainId`, `blockNumber`, `gitCommit`, `deployer`, `protocolOwner`, `protocolFeeRecipient`, `timelock`, `poolManager`, `positionManager`, `permit2`, `universalRouter`, `stateView`, `quoter`, `templateRegistry`, `moduleRegistry`, `assetRegistry`, `treasury`, `factory`, `distributor`, `feeRouter`, `curve`, `locker`, `graduationManager`, `hook`, `hookSalt`, `grantReserveEscrow`, `xdogToken`.
