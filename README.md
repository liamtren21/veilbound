# VEILBOUND · The Broken Accord

![The wardens face the Mother of Closed Doors in Hollow Orchard](docs/readme/mother-of-closed-doors.webp)

The Waymarks once guided the dead beyond the Quiet Reach. When they broke, the keepers fed them stolen memories. In this tactical dice roguelike, a squad of wardens crosses five haunted regions to return the names the land has kept.

[Open the game](https://veilbound-testnet-web-2441d075.vercel.app/) · [Run locally](#run-locally) · [Inspect the Testnet record](#the-testnet-record)

*Boss encounter captured in a shortened game preview. Public deployment and on-chain checks are documented below.*

## Enter Hollow Orchard

**Pick a Talisman.** Sign in with a NEAR wallet or Google, then choose **New Game** and select a starting squad. The sign-in flow opens in a separate window. The campaign runs through Hollow Orchard, Drowned Causeway, Ember Terraces, Iron Mourning, and Pale Basin.

**Read both dice pools.** Select a die and resolve its action. Rotate to change the lead, use Guard before a dangerous hit, or summon a companion for two rounds. Each encounter allows up to three summons.

**Plan the next stop.** Collect loot, equip the squad and choose a route. Elite encounters offer a different risk and reward. Curses carry across battles in a run, and remedies compete with equipment and healing for the same Copper. Open **Expedition** for rewarded-run preparation or **Marketplace** for trading, rentals and crafting. Wallet-signed actions require a verified NEAR testnet wallet.

### Game modes

- **Expedition**. Take a squad through branching routes, shops, elites, and five regional bosses.
- **Account Trials**. Unlock additional combat constraints through qualifying clears.
- **Weekly Oath**. Compete in a recurring challenge with a shared ruleset and leaderboard.
- **The Breach**. Make an individual attempt against a shared boss health pool.
- **Veil Duel**. Play a squad-versus-squad match through private rooms or bot practice.
- **Co-op Breach**. Coordinate actions with teammates against a shared encounter.

## From Expedition to the economy

![The Expedition loot screen shows the squad, equipment slots and rewards](docs/readme/expedition-loot.webp)

*The loot panel shows in-run Copper, supplies and equipment.*

The browser renders combat and handles input. For rewarded online runs, the game API keeps authoritative state and validates the action replay. NEAR contracts handle settlement, ownership, escrow and spending limits.

### Games With Real Economies

- **Copper and checkpoint claims.** Copper is the single in-game currency. Route choices and combat shape what a run earns and spends. For eligible checkpoints, the server prepares a signed receipt bound to the linked beneficiary, ruleset and checkpoint. Core checks the signed amount, prevents duplicate claims and enforces reward budgets.
- **Materials and crafting.** Players can trade recovered materials or spend them on recipes. Core reserves funded balances for market orders, so the same Copper cannot back two open orders.
- **NPC procurement and Field Contracts.** Dedicated NPC accounts can post buy orders under bounded budgets. Field Contracts give players another reason to take an elite route before reaching the corresponding boss.

### NFTs That Do Something

- **Relic.** Adds an eligible loadout option. Reservation and rental rules control who can equip it and when.
- **Chronicle.** Records eligible milestones that Core can check against evolution requirements.
- **Companion.** Represents a summon option that can be reserved for an eligible run. The encounter still enforces its summon rules.
- **Shop Charter.** Authorizes shop operations tied to an artifact vault. Core checks ownership and custody.

Relic owners sign their own evolution transactions. Core looks up the registered **Ascended** and **Legendary** recipes and checks the required Chronicle milestone, Copper, and materials. The project administrator registers each recipe once.

## The Testnet record

**Network:** NEAR testnet. Contract state was rechecked at finalized blocks **277724718–277724719** on **November 15, 2026 (UTC+7)**. The public API returned healthy, Core was active, Copper metadata returned ticker `COPPER` with two decimals, and both Relic recipe views returned data.

### Deployed contracts and vaults

Core serves the artifact collection. Its reusable Vault template creates per-artifact subaccounts, giving the Starter Relic and Shop Charter separate custody addresses.

| What to inspect | Verified result | Evidence |
| --- | --- | --- |
| Copper fungible token | `copper.vibebound.testnet` serves fungible-token metadata. Initial setup recorded a matching 1,000 Copper supply, custody balance and allocation. | [Copper account](https://testnet.nearblocks.io/address/copper.vibebound.testnet) · [Setup verification](deployments/testnet.setup.verified.json) |
| Core contract | `core.vibebound.testnet` is active. The prior unpause and code verification were recorded. | [Core account](https://testnet.nearblocks.io/address/core.vibebound.testnet) · [Unpause transaction](https://testnet.nearblocks.io/txns/GLHo6Mx1WVFCwE7Rs58cvQaSN5UNNBeoUpvjcX4QEFUp) · [Upgrade record](deployments/nft-run-lock/testnet.unpause.verified.json) |
| Starter Relic and Shop Charter | Setup verified NFT ownership and zero access keys on the two vaults. The Starter Relic still returned `ready` on the recheck. | [Starter vault](https://testnet.nearblocks.io/address/v-starter-001.core.vibebound.testnet) · [Shop vault](https://testnet.nearblocks.io/address/v-shop-001.core.vibebound.testnet) · [Setup verification](deployments/testnet.setup.verified.json) |

### Finalized transactions and state

| What to inspect | Verified result | Evidence |
| --- | --- | --- |
| NPC procurement | The Provisioner’s `place_market_order` finalized successfully with zero failed receipts. The pilot also recorded the unfilled order’s cancellation. | [Order transaction](https://testnet.nearblocks.io/txns/6Y2Jiq16DYk3Jd9x836pGqPFNmn61tfqos3L1omY36ZR) · [Pilot evidence](evidence/testnet/npc-market-pilot.verified.json) |
| Relic evolution | Two `register_evolution_recipe` calls finalized successfully with zero failed receipts. Both stages are readable on Core. | [Recipe transaction](https://testnet.nearblocks.io/txns/J8XqiZu1gA5xw1Z9Zr9QnyUsh1CMNs2dJibsZRTfuwAK) · [Receipt](evidence/testnet/evolution-0-J8XqiZu1gA5xw1Z9Zr9QnyUsh1CMNs2dJibsZRTfuwAK.json) |
| Material reward budgets | Ten material and regional trophy budgets were confirmed after configuration. | [Configuration transaction](https://testnet.nearblocks.io/txns/27GYBK7xBQCFs9WrQQ64CY34CpeoX2zVFUoaTDvXNyeo) · [Budget evidence](deployments/economy/testnet.material-budgets.verified.json) |
| Field Contract escrow | The operator reserved and released 2.50 Copper. A finalized `get_field_reward` view returned `released`. | [Operator account](https://testnet.nearblocks.io/address/field.vibebound.testnet) · [Reserve and release evidence](evidence/testnet/field-reserve-release-smoke.json) |

The public receipts above cover contract activation, setup, order placement, recipe registration and reserve/release. A public player checkpoint payout, a player fill of an NPC order, and a player Relic evolution each need their own finalized receipt. Local tests cover additional flows described below.

<details>
<summary>Re-run the transaction and contract checks</summary>

To reproduce the transaction lookup from PowerShell:

```powershell
$body = @{
  jsonrpc = '2.0'
  id = 'veilbound-proof'
  method = 'tx'
  params = @{
    tx_hash = '6Y2Jiq16DYk3Jd9x836pGqPFNmn61tfqos3L1omY36ZR'
    sender_account_id = 'provisioner.vibebound.testnet'
    wait_until = 'FINAL'
  }
} | ConvertTo-Json -Depth 5

$proof = Invoke-RestMethod -Method Post -Uri 'https://test.rpc.fastnear.com' `
  -ContentType 'application/json' -Body $body
$proof.result.final_execution_status
$proof.result.status
$proof.result.receipts_outcome | ForEach-Object { $_.outcome.status }
```

For contract reads, call NEAR RPC `query` with `request_type: call_function` and `finality: final`. On Core, check `is_paused`, `get_artifact` with `{"token_id":"starter-001"}`, or `get_evolution_recipe` with stage `1` or `2`. Encode arguments as Base64 JSON. [NEAR transaction RPC](https://docs.near.org/api/rpc/transactions)

</details>

## Run locally

Use Node.js 24 and npm. Run the following from this directory.

```sh
npm ci
npm --prefix server ci
node scripts/start-local-preview.mjs
```

Open [the local game](http://127.0.0.1:8787/expedition.html), [Expedition](http://127.0.0.1:8787/online-expedition.html), or [Game Modes](http://127.0.0.1:8787/modes.html). The preview uses a temporary database by default and a local starter adapter.

```sh
npm run test:backend
npm run test:gameplay
```

The November 15 run passed **97 backend tests** and **57 gameplay tests**. The opt-in PostgreSQL test was skipped. Coverage includes replay verification, five-region progression, reward caps, market receipt binding, crafting, wallet proof, curse remedies and companion limits. A separate deterministic replay records a [five-region win](evidence/gameplay/five-region-win.json) and [a defeat in region two](evidence/gameplay/region-two-loss.json).

See [operating instructions](docs/implementation/OPERATIONS.md) for testnet configuration.

<details>
<summary>Source map and architecture</summary>

| Layer | Responsibility | Source |
| --- | --- | --- |
| Browser | Combat presentation, input, map, shops and marketplace. Canvas and Three.js render the combat sprites and effects. The public client is hosted on Vercel. | [Expedition client](expedition.mjs) · [Combat renderer](expedition-art.mjs) |
| Rules engine | Deterministic dice, targeting, formation, curses, consumables, combat resolution and map progression. | [Expedition rules](expedition-rules.mjs) |
| Game API | Sessions, authoritative online run state, replay validation, receipt preparation, economy adapters and realtime rooms. The public API is hosted on Railway. | [HTTP API](server/src/http.mjs) · [Server entry](server/src/main.mjs) |
| NEAR contracts | Copper supply, receipt settlement, balances, escrow, NFT ownership and the vault template. | [Copper](contracts/copper) · [Core](contracts/core) · [Vault](contracts/vault) |

Online dice actions and VFX run through the game’s client and server. NEAR handles durable outcomes where ownership, payment or custody matters. Authorized reward receipts bridge the server’s replay validation to Core’s settlement checks.

</details>
