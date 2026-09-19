#!/usr/bin/env bash
# Derive the testnet role wallets from TEST_MNEMONIC in .env.dev (generated on first run), fund them from the deployer,
# and write contracts/deployments/<chainId>.roles.json (addresses only; keys never leave .env.dev).
# usage: scripts/testnet-roles.sh [fund-amount-okb]      (default 0.03)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.foundry/bin:$PATH"
set -a; source "$ROOT/.env.dev"; set +a
FUND="${1:-0.03}"
RPC="https://xlayer-testnet.g.alchemy.com/v2/$ALCHEMY_API_KEY"
CHAIN=$(cast chain-id --rpc-url "$RPC")
[ "$CHAIN" = "196" ] && { echo "refusing to run against mainnet"; exit 1; }

if [ -z "${TEST_MNEMONIC:-}" ]; then
  MN=$(cast wallet new-mnemonic --words 12 | sed -n 's/^Phrase:[[:space:]]*//p')
  [ -n "$MN" ] || MN=$(cast wallet new-mnemonic --words 12 | grep -E '^([a-z]+ ){11}[a-z]+$' | head -1)
  printf '\n# Testnet role-wallet mnemonic. Testnet only - never send real funds to these addresses.\nTEST_MNEMONIC="%s"\n' "$MN" >> "$ROOT/.env.dev"
  export TEST_MNEMONIC="$MN"
  echo "generated TEST_MNEMONIC into .env.dev"
fi

ROLES=(creator buyer alice bob carol swapper)
DEPLOYER=$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")
JSON="{"
for i in "${!ROLES[@]}"; do
  ROLE=${ROLES[$i]}
  ADDR=$(cast wallet address --mnemonic "$TEST_MNEMONIC" --mnemonic-index "$i")
  BAL=$(cast balance --rpc-url "$RPC" --ether "$ADDR")
  NEED=$(python3 -c "print(1 if float('$BAL') < float('$FUND')/2 else 0)")
  if [ "$NEED" = "1" ]; then
    cast send --rpc-url "$RPC" --private-key "$DEPLOYER_PRIVATE_KEY" "$ADDR" --value "${FUND}ether" >/dev/null
    BAL=$(cast balance --rpc-url "$RPC" --ether "$ADDR")
  fi
  printf "%-8s index=%d %s balance=%s OKB\n" "$ROLE" "$i" "$ADDR" "$BAL"
  JSON+="\"$ROLE\":\"$ADDR\","
done
JSON="${JSON%,},\"deployer\":\"$DEPLOYER\",\"chainId\":$CHAIN}"
echo "$JSON" | python3 -m json.tool > "$ROOT/contracts/deployments/$CHAIN.roles.json"
echo "wrote contracts/deployments/$CHAIN.roles.json"
