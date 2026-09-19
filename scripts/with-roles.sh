#!/usr/bin/env bash
# Like with-env.sh, but also exports ROLE_<NAME>_PK / ROLE_<NAME> for the six testnet roles derived from TEST_MNEMONIC.
# usage: scripts/with-roles.sh forge script script/LifecycleTestnet.s.sol --sig 'phase1()' --rpc-url xlayer_testnet --broadcast
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.foundry/bin:$PATH"
set -a; source "$ROOT/.env.dev"; set +a
[ -n "${TEST_MNEMONIC:-}" ] || { echo "TEST_MNEMONIC missing; run scripts/testnet-roles.sh first"; exit 1; }
ROLES=(CREATOR BUYER ALICE BOB CAROL SWAPPER)
for i in "${!ROLES[@]}"; do
  export "ROLE_${ROLES[$i]}_PK=$(cast wallet private-key "$TEST_MNEMONIC" "$i")"
  export "ROLE_${ROLES[$i]}=$(cast wallet address --mnemonic "$TEST_MNEMONIC" --mnemonic-index "$i")"
done
exec "$@"
