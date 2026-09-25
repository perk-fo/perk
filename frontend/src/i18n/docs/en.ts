import type { DocsContent } from "./types";

const docs: DocsContent = {
  sections: [
    {
      id: "overview",
      title: "What Perk is",
      blocks: [
        {
          kind: "p",
          text: "Perk is a modular Uniswap v4 Hook meme launchpad on X Layer. Creators pick a template and launch without writing contracts. Memes trade on a constant-product bonding curve, graduate to their own Uniswap v4 pool at a fixed threshold, and share a 1% trading fee with creators, holders and liquidity."
        },
        {
          kind: "p",
          text: "The architecture is built on composable Hook modules: fee structures, Grant mechanics and market rules are packaged in templates. New economic models can be introduced as new template versions without touching existing launches. Every launch parameter is committed in a configHash and cannot be changed after creation."
        },
        {
          kind: "list",
          items: [
            "Creators earn a fixed 50% of the fee on every trade, for as long as the meme trades.",
            "Wallets holding at least 1,000 tokens share 25% of every fee as Quote Rewards, paid in the pairing asset.",
            "Holders of the pairing asset can provide protocol-matched liquidity to newly graduated Perk Launch memes (LP Grant)."
          ]
        }
      ]
    },
    {
      id: "lifecycle",
      title: "The life of a token",
      blocks: [
        {
          kind: "steps",
          items: [
            {
              title: "Create",
              text: "Pick a pairing asset (OKB or another approved asset), a template (Perk Launch or Standard Launch) and an optional dev buy. The contract predicts the meme's address and configHash, and the launch commits every rule through that configHash."
            },
            {
              title: "Trade",
              text: "The meme trades on a constant-product bonding curve, and fees accrue from the first trade. Every buy and sell carries a minimum amount out. For Perk Launch, holdings of the pairing asset are measured for LP Grant eligibility, and wallets can bind an inviter before graduation."
            },
            {
              title: "Graduate",
              text: "When the net amount raised reaches the fixed threshold, anyone can send the graduation transaction. It creates the official Uniswap v4 pool at the curve's final price and locks the initial liquidity permanently, in full or not at all."
            },
            {
              title: "Activate (Perk Launch only)",
              text: "Once the allocation list's Merkle root has passed public review and gone live, the grant window opens. Eligible holders contribute their own pairing asset and the protocol matches it from the 15% reserve. Allocations shrink over the window, so activating early is worth more."
            },
            {
              title: "Earn and exit",
              text: "Trading continues in the pool with the same 1% fee. Quote Rewards accrue to holders and grant positions earn their pool fees. After the minimum LP time a grant position can exit at any time; LP Grant below explains how its principal is settled."
            }
          ]
        },
        {
          kind: "note",
          text: "If a token reaches its threshold but its graduation cannot complete, it can be rescued into refunds: after a public delay, holders redeem their tokens for a pro-rata share of the funds it raised."
        }
      ]
    },
    {
      id: "fees",
      title: "Fees",
      blocks: [
        {
          kind: "p",
          text: "Perk charges a 1% total trading fee on both the bonding curve and the graduated Uniswap v4 pool, on buys and sells alike. The split is part of the meme's template and cannot be changed after launch."
        },
        {
          kind: "table",
          head: [
            "Recipient",
            "Share",
            "What it means"
          ],
          rows: [
            [
              "Dev",
              "50%",
              "Fixed creator income from every trade, paid in the pairing asset"
            ],
            [
              "Holder Rewards",
              "25%",
              "Quote Rewards: paid in the pairing asset to wallets holding at least 1,000 tokens, in proportion to balance"
            ],
            [
              "Liquidity",
              "15%",
              "On the curve, saved for the graduation liquidity; in the pool, the LP fee"
            ],
            [
              "Community Treasury",
              "5%",
              "On-chain treasury; moving its funds is public and waits for a timelock"
            ],
            [
              "Perk Protocol",
              "5%",
              "Protocol operations"
            ]
          ]
        },
        {
          kind: "p",
          text: "The initial liquidity locked at graduation earns the pool's LP fee like any position, and those fees go to the Community Treasury. Any payout can be triggered by anyone and always goes to the same recipient. Holder rewards accumulate until they are claimed and never expire."
        }
      ]
    },
    {
      id: "templates",
      title: "Templates, modules and the configHash",
      blocks: [
        {
          kind: "p",
          text: "A template is a registered set of launch parameters: supply split, curve, graduation threshold, fee split, pool settings and the modules that are switched on. A registered template can never be edited; different numbers mean a new template version, which applies only to new launches. There are two:"
        },
        {
          kind: "table",
          head: [
            "",
            "Perk Launch (default)",
            "Standard Launch"
          ],
          rows: [
            [
              "Supply split",
              "85% curve and graduation, 15% LP Grant reserve",
              "100% curve and graduation"
            ],
            [
              "LP Grant",
              "Yes: holders of the pairing asset get matching capital",
              "No"
            ],
            [
              "Referrals",
              "Two-sided, 10% each",
              "Not applicable"
            ],
            [
              "Price guard",
              "Grant activation and exit check the pool's reference price",
              "Not applicable"
            ],
            [
              "Curve",
              "Constant-product",
              "Constant-product, same parameters"
            ],
            [
              "Graduation threshold",
              "85 units of the pairing asset",
              "85 units of the pairing asset"
            ],
            [
              "Fee",
              "1%, split 50 / 25 / 15 / 5 / 5",
              "1%, split 50 / 25 / 15 / 5 / 5"
            ],
            [
              "Tokens left over at graduation",
              "Burned",
              "Burned"
            ]
          ]
        },
        {
          kind: "p",
          text: "Modules are the features a template switches on. The official-pool guard, the fee router and holder rewards are in every template; LP Grant and referral boosts are on for Perk Launch only. Both templates use the same curve, and parameters can differ by pairing asset; future templates can introduce new economic models without affecting existing launches."
        },
        {
          kind: "p",
          text: "The configHash is a hash of a launch's configuration: chain, factory, creator, token address, pairing asset, template, hook version and modules. The launch transaction reverts unless it matches the configuration the creator previewed. It is stored on-chain, registered with the pool at graduation and shown on every token page, and the token's egg picture is generated from it."
        }
      ]
    },
    {
      id: "pairing-assets",
      title: "Pairing assets and prices",
      blocks: [
        {
          kind: "p",
          text: "The pairing asset is what a token is bought with and priced in. Fees, holder rewards, LP Grant deposits and refunds are all paid in it. It can be native OKB or an ERC-20 that the asset registry allows, including tokenised stocks. The contracts work in each asset's own decimals."
        },
        {
          kind: "p",
          text: "Prices, market caps and volumes are shown in US dollars, converted at the pairing asset's current market price, with the amount in the pairing asset shown underneath."
        }
      ]
    },
    {
      id: "lp-grant",
      title: "LP Grant",
      blocks: [
        {
          kind: "p",
          text: "Any holder of a supported pairing asset on X Layer can take part: ERC-20 holders are counted automatically, and OKB holders claim the free LP Grant pass first."
        },
        {
          kind: "p",
          text: "A Perk Launch meme sets aside 15% of its supply, 150 million tokens, as a matching reserve. After graduation, once the activation conditions are met, you contribute your own pairing asset and the protocol matches it with meme tokens, straight into a Uniswap v4 position the vault holds for you. Nothing enters your wallet as an airdrop; it all goes into the pool. Your position earns 100% of its LP fees, in both assets."
        },
        {
          kind: "steps",
          items: [
            {
              title: "Snapshot",
              text: "Allocations go to holders of the pairing asset, measured over a window before graduation (seven days by default). For OKB, wallets that opted in on-chain with the LP Grant pass are counted. For an ERC-20 pairing asset, every holder is counted except contracts."
            },
            {
              title: "Review",
              text: "The allocation list is published with its Merkle root and stays in public review for a set delay. Anyone can recompute it with the open-source snapshot tool before it goes live."
            },
            {
              title: "Activation",
              text: "Once the root is active, each eligible wallet registers its allocation and opens positions. Allocations shrink linearly over the grant window, so taking them early is worth more."
            },
            {
              title: "Exit",
              text: "After the minimum LP time a participant can exit whenever they choose; nothing, not even the emergency pause, can block it. They get back up to the value of their deposit, in the pairing asset first: if the price rose, the surplus goes to the other grant positions or the treasury; if it fell, granted tokens cover part of the loss."
            },
            {
              title: "End",
              text: "When the window closes, every reserve token that did not become liquidity is burned."
            }
          ]
        },
        {
          kind: "table",
          head: [
            "Price at exit, against entry",
            "Returned, as value at the exit price"
          ],
          rows: [
            [
              "Unchanged or higher",
              "100% of the deposit, in the pairing asset"
            ],
            [
              "20% lower",
              "About 99%, pairing asset plus granted tokens"
            ],
            [
              "50% lower",
              "About 91%, pairing asset plus granted tokens"
            ],
            [
              "75% lower",
              "75%, pairing asset plus granted tokens"
            ]
          ]
        },
        {
          kind: "p",
          text: "Trading fees are paid on top, and so are incentives: the surplus from other participants' exits, shared among open positions in proportion to their liquidity and how long it has been active."
        }
      ]
    },
    {
      id: "referrals",
      title: "Referrals",
      blocks: [
        {
          kind: "p",
          text: "Two-sided: both sides benefit."
        },
        {
          kind: "list",
          items: [
            "Every connected wallet has an invite link. A wallet can bind one inviter, permanently; no one can change or remove a binding. A binding counts for a meme only if it was made before that meme graduated.",
            "An invited wallet's base allocation in each later LP Grant campaign is increased by 10%.",
            "When an invited wallet activates its base allocation, the inviter earns a credit of 10% of the amount activated, up to half of the inviter's own base allocation, while the campaign's referral budget lasts.",
            "A credit is allocation, not tokens: to use it, the inviter contributes their own pairing asset like any other activation. Referrals pay no cash and mint nothing; boosts and credits come from the meme's LP Grant reserve."
          ]
        }
      ]
    },
    {
      id: "safety",
      title: "What is fixed and what can be paused",
      blocks: [
        {
          kind: "p",
          text: "Immutable at creation, with no exceptions. The configHash commits the template, pairing asset, hook and module set, and with the template its curve, fee, Grant, exclusion and supply rules. Newer template versions apply only to new launches; they never change existing memes."
        },
        {
          kind: "list",
          items: [
            "A token's supply, rules and fee split are fixed at creation. There is no mint function; supply can only go down.",
            "The initial liquidity of every official pool is locked permanently; no admin can withdraw it. Its fees go to the Community Treasury.",
            "Graduation is all-or-nothing: there is never an official pool without its liquidity, or at any other price than the curve's final one.",
            "Each grant position's deposit and entry price are recorded at activation and settle its exit; nothing changes them later.",
            "The emergency pause covers new launches, curve buys, graduation and joining LP Grant. Selling, withdrawing, claiming and refunds can never be paused.",
            "A rescue can only return funds to holders, only after a public delay, and not while graduation is paused.",
            "Moving the treasury's funds is public and waits for a timelock."
          ]
        }
      ]
    },
    {
      id: "egg",
      title: "The egg",
      blocks: [
        {
          kind: "p",
          text: "Before graduation a meme trades on its bonding curve and is shown as an egg. After graduation it trades in its own Uniswap v4 pool, where the permanently locked initial liquidity gives it baseline depth from day one. The shell's colour, pattern, width and tilt are generated from the meme's configHash, so the same meme always looks the same. Inside is the meme's image, or a generated creature if the creator uploaded none. Hover an egg to look inside; on a meme's page, an X-ray lens shows the contents."
        },
        {
          kind: "table",
          head: [
            "State",
            "When"
          ],
          rows: [
            [
              "Sealed",
              "The token is on its bonding curve"
            ],
            [
              "Cracking",
              "The threshold is reached and graduation is pending"
            ],
            [
              "Hatched",
              "The token has graduated: its image in a round frame, with the shell broken beside it"
            ],
            [
              "Grey",
              "The token is being refunded"
            ]
          ]
        }
      ]
    },
    {
      id: "testnet",
      title: "Testnet",
      blocks: [
        {
          kind: "p",
          text: "This deployment runs on X Layer testnet (chain 1952). All tokens, assets and positions have no real value, and parameters can differ from mainnet: so that a full cycle takes hours instead of weeks, the testnet uses a 1-hour review, a 2-hour root deadline and a 1-hour rescue delay, and adds a fast template with a graduation threshold 10,000 times smaller, a 2-hour grant window and a 10-minute minimum LP time. Creation, trading, Grant activation, referrals and exits all work. The memes already listed are created and traded by a simulator and are test data."
        },
        {
          kind: "contracts"
        }
      ]
    },
    {
      id: "glossary",
      title: "Glossary",
      blocks: [
        {
          kind: "table",
          head: [
            "Term",
            "Meaning"
          ],
          rows: [
            [
              "Bonding curve",
              "Constant-product pricing before graduation, set by virtual reserves. Fees accrue from the first trade."
            ],
            [
              "Graduation",
              "The move from the bonding curve to the meme's own Uniswap v4 pool when the fixed threshold is reached. The initial liquidity is locked permanently."
            ],
            [
              "Graduation threshold",
              "The net amount of the pairing asset a curve must raise before it closes."
            ],
            [
              "Official pool",
              "The single Uniswap v4 pool per token that carries the Perk hook and its locked initial liquidity."
            ],
            [
              "Perk hook",
              "The Uniswap v4 hook that takes the Perk fee on every swap in an official pool."
            ],
            [
              "configHash",
              "The on-chain commitment of all launch parameters, fixed at creation."
            ],
            [
              "Template",
              "A versioned, unchangeable set of launch parameters and modules. New templates extend the platform without changing existing launches."
            ],
            [
              "Pairing asset",
              "The asset a token is bought with and priced in: OKB or an allowed ERC-20."
            ],
            [
              "Quote Rewards",
              "The holders' 25% of every fee, paid in the pairing asset to wallets with at least 1,000 tokens."
            ],
            [
              "Initial liquidity",
              "The first liquidity added at graduation. Locked permanently; its LP fees go to the Community Treasury."
            ],
            [
              "Community Treasury",
              "Receives 5% of fees, plus the surplus of a grant exit when no other position is open. Moving its funds is public and waits for a timelock."
            ],
            [
              "LP Grant",
              "15% of a Perk Launch meme's supply reserved as matching meme tokens. Not an airdrop: participants contribute their own pairing asset to activate it."
            ],
            [
              "Grant position",
              "The Uniswap v4 position created by an activation, held by the vault for its owner. Each activation is a separate position."
            ],
            [
              "LP Grant pass",
              "The on-chain opt-in that makes an OKB wallet count in LP Grant snapshots."
            ],
            [
              "Grant window",
              "The period after a root is activated during which allocations can be taken; they shrink linearly to zero over it (14 days by default)."
            ],
            [
              "Referral credit",
              "Allocation an inviter earns when an invited wallet activates: 10% of the amount, up to half of the inviter's own base allocation. Used by contributing the pairing asset like any activation."
            ],
            [
              "Minimum LP time",
              "How long a grant position must stay open before it can exit."
            ],
            [
              "Root",
              "The Merkle root of a campaign's allocation list, published on-chain for review before it is activated."
            ]
          ]
        }
      ]
    }
  ]
};

export default docs;
