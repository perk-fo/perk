import type { DocsContent } from "./types";

const docs: DocsContent = {
  sections: [
    {
      id: "overview",
      title: "What Perk is",
      blocks: [
        {
          kind: "p",
          text: "Perk is a meme launchpad on X Layer built around the people who make each market: its creator, its holders, and the holders of OKB and other pairing assets who provide its liquidity. Each has a share of what the market produces, fixed when the meme launches and checkable by anyone. A meme trades on a bonding curve until buyers have paid in a set amount of its pairing asset; it then moves, in one transaction, to its own Uniswap v4 pool, whose starting liquidity is locked permanently.",
        },
        {
          kind: "p",
          text: "Every trade pays a 1% fee that is split between the token's creator, its holders, liquidity, a community treasury and the protocol. A token's rules are fixed when it is created and can be checked by anyone. After graduation, part of a token's supply can be used to pay for liquidity from holders of the pairing asset (LP Grant).",
        },
        {
          kind: "list",
          items: [
            "Creators earn half of every trading fee on their token, for as long as it trades.",
            "Holders of at least 1,000 tokens share a quarter of every fee, paid in the pairing asset.",
            "Holders of the pairing asset can provide subsidised liquidity to newly graduated Perk Launch tokens.",
          ],
        },
      ],
    },
    {
      id: "lifecycle",
      title: "The life of a token",
      blocks: [
        {
          kind: "steps",
          items: [
            {
              title: "Launch",
              text: "The creator sets a name, symbol, image, pairing asset and template. The contract predicts the token's address and configHash, and the creator signs that exact configuration. An optional first buy (the dev buy) can be made in the same transaction.",
            },
            {
              title: "Bonding curve",
              text: "The price rises with every buy and falls with every sell, and each trade pays the 1% fee. Every buy and sell carries a minimum amount out.",
            },
            {
              title: "Threshold",
              text: "When the net amount raised reaches the template's graduation threshold, the curve closes to buying and selling and the token is ready to graduate.",
            },
            {
              title: "Graduation",
              text: "Anyone can send the graduation transaction. It creates the token's official Uniswap v4 pool at the curve's final price, adds the starting liquidity and locks it permanently. It either completes in full or changes nothing, so the price does not jump.",
            },
            {
              title: "Pool",
              text: "The token trades in its pool, still with the 1% fee. Anyone can add their own liquidity and withdraw it at any time. For Perk Launch tokens, the LP Grant campaign opens.",
            },
          ],
        },
        {
          kind: "note",
          text: "If a token reaches its threshold but its graduation cannot complete, it can be rescued into refunds: after a public delay, holders redeem their tokens for a pro-rata share of the funds it raised.",
        },
      ],
    },
    {
      id: "fees",
      title: "Fees",
      blocks: [
        {
          kind: "p",
          text: "Every trade pays 1% of its value, on the curve and in the pool, when buying and when selling. The split is part of the token's template and cannot be changed later.",
        },
        {
          kind: "table",
          head: ["Recipient", "Share of the fee", "Share of volume", "How it is paid"],
          rows: [
            ["Creator", "50%", "0.50%", "In the pairing asset, claimable at any time"],
            ["Holders with at least 1,000 tokens", "25%", "0.25%", "In the pairing asset, in proportion to balance"],
            ["Liquidity", "15%", "0.15%", "Added to the pool at graduation, then the pool's LP fee"],
            ["Community treasury", "5%", "0.05%", "In the pairing asset"],
            ["Protocol", "5%", "0.05%", "In the pairing asset"],
          ],
        },
        {
          kind: "p",
          text: "Any payout can be triggered by anyone and always goes to the same recipient. Holder rewards accumulate until they are claimed and never expire.",
        },
      ],
    },
    {
      id: "templates",
      title: "Templates, modules and the configHash",
      blocks: [
        {
          kind: "p",
          text: "A template is a registered set of parameters: supply split, curve, graduation threshold, fee split, pool settings and the modules that are switched on. A registered template can never be edited; different numbers mean a new template. There are two:",
        },
        {
          kind: "table",
          head: ["", "Perk Launch", "Standard Launch"],
          rows: [
            ["Total supply", "1,000,000,000", "1,000,000,000"],
            ["Sold on the curve (at most)", "67.42%", "67.42%"],
            ["Pool reserve", "17.58%", "32.58%"],
            ["LP Grant reserve", "15%", "None"],
            ["Graduation threshold", "85 units of the pairing asset", "85 units of the pairing asset"],
            ["Fee", "1%, split 50 / 25 / 15 / 5 / 5", "1%, split 50 / 25 / 15 / 5 / 5"],
            ["Tokens left over at graduation", "Burned", "Burned"],
          ],
        },
        {
          kind: "p",
          text: "Modules are the features a template switches on. The official-pool guard, the fee router and holder rewards are in every template; LP Grant and referral boosts are on for Perk Launch only.",
        },
        {
          kind: "p",
          text: "The configHash is a hash of a launch's configuration: chain, factory, creator, token address, pairing asset, template, hook version and modules. The launch transaction reverts unless it matches the configuration the creator previewed. It is stored on-chain, registered with the pool at graduation and shown on every token page, and the token's egg picture is generated from it.",
        },
      ],
    },
    {
      id: "pairing-assets",
      title: "Pairing assets and prices",
      blocks: [
        {
          kind: "p",
          text: "The pairing asset is what a token is bought with and priced in. Fees, holder rewards, LP Grant deposits and refunds are all paid in it. It can be native OKB or an ERC-20 that the asset registry allows, including tokenised stocks. The contracts work in each asset's own decimals.",
        },
        {
          kind: "p",
          text: "Prices, market caps and volumes are shown in US dollars, converted at the pairing asset's current market price, with the amount in the pairing asset shown underneath.",
        },
      ],
    },
    {
      id: "lp-grant",
      title: "LP Grant",
      blocks: [
        {
          kind: "p",
          text: "A Perk Launch token reserves 15% of its supply, 150 million tokens, for LP Grant. After graduation the reserve supplies the token side of new liquidity: participants deposit only the pairing asset, and the combined position earns the pool's 0.15% LP fee.",
        },
        {
          kind: "steps",
          items: [
            {
              title: "Snapshot",
              text: "Allocations go to holders of the pairing asset, measured over a window before graduation (seven days by default). For OKB, wallets that opted in on-chain with the LP Grant pass are counted. For an ERC-20 pairing asset, every holder is counted except contracts.",
            },
            {
              title: "Review",
              text: "The allocation list is published with its Merkle root and stays in public review for a set delay. Anyone can recompute it with the open-source snapshot tool before it goes live.",
            },
            {
              title: "Activation",
              text: "Once the root is active, each eligible wallet registers its allocation and opens positions. Allocations shrink linearly over the grant window, so taking them early is worth more.",
            },
            {
              title: "Exit",
              text: "After the minimum LP time a participant can exit whenever they choose; nothing, not even the emergency pause, can block it. They get back at most the value of their deposit: if the price rose, the surplus goes to the other grant positions or the treasury; if it fell, granted tokens cover part of the loss.",
            },
            {
              title: "End",
              text: "When the window closes, every reserve token that did not become liquidity is burned.",
            },
          ],
        },
        {
          kind: "table",
          head: ["Price at exit, against entry", "Returned, as value at the exit price"],
          rows: [
            ["Unchanged or higher", "100% of the deposit, in the pairing asset"],
            ["20% lower", "About 99%, pairing asset plus granted tokens"],
            ["50% lower", "About 91%, pairing asset plus granted tokens"],
            ["75% lower", "75%, pairing asset plus granted tokens"],
          ],
        },
        {
          kind: "p",
          text: "Trading fees are paid on top, and so are incentives: the surplus from other participants' exits, shared among open positions in proportion to their liquidity and how long it has been active.",
        },
      ],
    },
    {
      id: "referrals",
      title: "Referrals",
      blocks: [
        {
          kind: "list",
          items: [
            "Every connected wallet has an invite link. A wallet can bind one inviter, permanently; no one can change or remove a binding.",
            "An invited wallet's base allocation in each later LP Grant campaign is increased by 10%.",
            "When an invited wallet activates its allocation, the inviter earns a credit of 10% of the amount, up to half of the inviter's own base allocation in that campaign.",
            "A binding counts for a token only if it was made before that token graduated. Referrals pay no cash and mint nothing: boosts and credits come from the token's LP Grant reserve.",
          ],
        },
      ],
    },
    {
      id: "safety",
      title: "What is fixed and what can be paused",
      blocks: [
        {
          kind: "list",
          items: [
            "A token's supply, rules and fee split are fixed at creation. There is no mint function; supply can only go down.",
            "The starting liquidity of every official pool is locked permanently. Its fees go to the community treasury.",
            "Graduation is all-or-nothing: there is never an official pool without its liquidity, or at any other price than the curve's final one.",
            "The emergency pause covers new launches, curve buys, graduation and joining LP Grant. Selling, withdrawing, claiming and refunds can never be paused.",
            "A rescue can only return funds to holders, only after a public delay, and not while graduation is paused.",
            "Moving the treasury's funds is public and waits for a timelock.",
          ],
        },
      ],
    },
    {
      id: "egg",
      title: "The egg",
      blocks: [
        {
          kind: "p",
          text: "Every token is shown as an egg until it graduates. The shell's colour, pattern, width and tilt are generated from the token's configHash, so the same token always looks the same. Inside is the token's image, or a generated creature if the creator uploaded none. Hover an egg to look inside; on a token page, an X-ray lens shows the contents.",
        },
        {
          kind: "table",
          head: ["State", "When"],
          rows: [
            ["Sealed", "The token is on its bonding curve"],
            ["Cracking", "The threshold is reached and graduation is pending"],
            ["Hatched", "The token has graduated: its image in a round frame, with the shell broken beside it"],
            ["Grey", "The token is being refunded"],
          ],
        },
      ],
    },
    {
      id: "testnet",
      title: "Testnet",
      blocks: [
        {
          kind: "p",
          text: "Perk runs on X Layer testnet (chain 1952). So that a full cycle takes hours instead of weeks, the testnet uses a 1-hour review, a 2-hour root deadline and a 1-hour rescue delay, and adds a fast template with a graduation threshold 10,000 times smaller, a 2-hour grant window and a 10-minute minimum LP time. The tokens on the testnet are created and traded by a simulator and are test data.",
        },
        { kind: "contracts" },
      ],
    },
    {
      id: "glossary",
      title: "Glossary",
      blocks: [
        {
          kind: "table",
          head: ["Term", "Meaning"],
          rows: [
            ["Bonding curve", "The contract a token trades on before graduation; its price is set by virtual reserves and moves with every trade."],
            ["Graduation threshold", "The net amount of the pairing asset a curve must raise before it closes."],
            ["Official pool", "The single Uniswap v4 pool per token that carries the Perk hook and its locked starting liquidity."],
            ["Perk hook", "The Uniswap v4 hook that takes the Perk fee on every swap in an official pool."],
            ["configHash", "The hash of a launch's configuration, fixed at creation."],
            ["Template", "A registered, unchangeable set of launch parameters."],
            ["Pairing asset", "The asset a token is bought with and priced in: OKB or an allowed ERC-20."],
            ["Holder rewards", "The holders' 25% of every fee, shared by balance among wallets with at least 1,000 tokens."],
            ["LP Grant", "Subsidised liquidity paid from a Perk Launch token's 15% reserve after graduation."],
            ["LP Grant pass", "The on-chain opt-in that makes an OKB wallet count in LP Grant snapshots."],
            ["Grant window", "The period after a root is activated during which allocations can be taken; they shrink to zero over it."],
            ["Minimum LP time", "How long a grant position must stay open before it can exit."],
            ["Root", "The Merkle root of a campaign's allocation list, published on-chain for review before it is activated."],
          ],
        },
      ],
    },
  ],
};

export default docs;
