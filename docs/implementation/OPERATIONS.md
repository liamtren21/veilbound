# VEILBOUND API operations

The API runs on Node 24 with SQLite. Run one API replica per persistent volume. Point the public web origin at the API through a same-origin reverse proxy. Forward `/api/` with WebSocket upgrades enabled and use HTTPS for public traffic so the session cookie is Secure.

## Local container

From the project root:

```powershell
docker build -t veilbound-api:local .
docker volume create veilbound-local-data
docker run --name veilbound-local -d -p 127.0.0.1:8787:8787 --mount source=veilbound-local-data,target=/app/data -e VEILBOUND_ORIGIN=https://demo.example.test -e VEILBOUND_TELEMETRY=true veilbound-api:local
Invoke-RestMethod http://127.0.0.1:8787/health
```

The image runs as the unprivileged Node user. The example HTTPS origin is a placeholder for the reverse proxy's actual origin. The loopback HTTP health probe connects to the API directly. For browser sessions, use that HTTPS proxy so the browser can send the Secure session cookie. For a local HTTP browser demo, run the API outside Docker with `VEILBOUND_BIND=127.0.0.1` and the actual local web origin. Use `VEILBOUND_BIND=0.0.0.0` inside the container and keep the host port loopback-only when using a local proxy. The container listens on `VEILBOUND_PORT` (8787 by default). Keep `VEILBOUND_DATA_DIR` on the persistent volume.

Without testnet environment variables, Guest sessions and Practice run locally. Review `server/.env.testnet.runtime.example` for the optional testnet integrations. Mount secret files read-only and use the container paths in the corresponding environment variables. Keep the mode seed secret stable between restarts. Update Weekly and Breach dates explicitly before opening a new event.

The local smoke test built the image, started the API as the Node user, created a Guest and a Practice run, restarted the container, and resumed the same run from the volume. It checked the Secure cookie attribute and redacted telemetry. The smoke connected directly to loopback with a test client. Browser TLS proxy and remote hosting still need verification at the selected origin.

## Verify and recover

- Check `GET /health`, then create a Guest, start Practice and save the returned run ID. Restart the API and verify that the same cookie resumes the same run. `/health` only checks that the HTTP process is reachable.
- Set `VEILBOUND_TELEMETRY=true` to emit structured JSON to stdout. Aggregate request latency, status and abort count by the fixed route label. Operation events report only the operation category and outcome. Telemetry omits request paths, query strings, bodies, headers and player IDs.
- Stop the API before copying the volume for a consistent backup. Preserve the SQLite files, including any WAL and SHM files present in the volume. Restore the entire snapshot into a separate volume and verify Guest resume and replay before switching traffic.
- During a testnet RPC incident, keep Practice available. Check finalized chain state before treating a timed-out market or reward transaction as failed. Field Contract recovery reconciles the finalized reservation and handles expiry. Preserve pending operation records during rollback.
- Before upgrading on-chain code, verify the target artifact hash and exact unsigned plan. Keep the Core pause, upgrades, verification and unpause as separate evidence. Confirm the deployed code and custody through finalized views.

### Reconcile an old Expedition reservation

After the reward service has verified the new epoch and recorded the unsigned release for a run, inspect its signed checkpoints against one finalized testnet block. Run from the project root with the original SQLite reward ledger on the API data volume.

```powershell
node scripts/reconcile-checkpoint-rewards.mjs --db path/to/run-rewards.sqlite --run RUN_ID
```

For the containerized API, run `docker exec veilbound-local node scripts/reconcile-checkpoint-rewards.mjs --db /app/data/run-rewards.sqlite --run RUN_ID`. Substitute the API container name and its configured data path.

Use `--config PATH` if the API uses a custom reward deployment configuration. Save the JSON preview with the recovery record. After checking the run and finalized block, rerun with `--apply` to recheck finalized state and reclaim eligible quota. Keep the resulting JSON with the SQLite backup. The command releases lifetime quota for a checkpoint only when Core reports it expired or when Core has no operation and the finalized block is strictly past the receipt deadline. A pending operation may have minted Copper while its Core callback is still unresolved. Leave its quota reserved and use the beneficiary's existing settlement retry flow. Settled claims retain their quota.

Each release records the claim ID, amount, outcome, finalized block, timestamp and epoch in `run_reward_claim_releases` in the same transaction as the quota update. Repeating the command preserves the original audit row and releases that amount only once. The command uses public chain views and needs no wallet or signing key.

## Ranked and profession quests

Set `VEILBOUND_RANKED_DUEL_ENABLED=true` to enable the ranked queue on a local server. Test matches use normalized teams and affect only the local rating ledger. Custom and practice matches remain separate.

Profession objectives are derived from verified Expedition actions and paired with checkpoint requirements. Use a Reed Salve outside battle on a wounded hero for Apothecary, clear the Bailiff’s Vent for Relicsmith, and speak the names at the Hollow Orchard memorial for Binder. Record progress from Expedition or Workshop. Existing specialty unlocks carry over.

The Economy screen can fetch a read-only testnet quote for Tidepool sample assets. VEILBOUND payment remains via NEAR testnet wallet.

## NPC procurement pilot

Run the default read-only preflight with `node scripts/npc-market-pilot.mjs <expiry-UTC>`. It reads all four funded testnet accounts, verifies each operating key and reports proposals. To execute the bounded pilot locally, set `VEILBOUND_NPC_DATA_DIR` to a persistent private directory and add `--execute-testnet`. The pilot caps new commitments at 2 Copper per NPC in its persisted ledger and cancels tracked unfilled orders after they expire. The existing Provisioner ledger is reused if present. Use one pilot process per ledger. Set `VEILBOUND_NPC_MARKET_INDEX` to the same local `market.sqlite` used by the game API to publish verified live orders to the in-game market. Keep `VEILBOUND_NPC_DATA_DIR` pointed at the existing private ledger so the pilot retains its commitment cap across restarts. The tested orders and finalized cancellations are in `evidence/testnet/npc-market-pilot.verified.json`.

## Relic evolution registration

Provide an approved JSON array for stages 1 and 2. Each entry contains `stage`, a published `media` URI, `imagePath` for the matching original bytes, `materials` as an ID-to-quantity map and `copperAtomic`. Quantities and Copper use decimal strings. Run `node scripts/prepare-evolution.mjs <approved-recipes.json> deployments/testnet.evolution.unsigned.json`. Review the pinned media, SHA-256 and costs, set `VEILBOUND_DEPLOY_PHASE=evolution`, then run the wallet server. The owner signs once and the wallet page checks both recipe views at finality. Use the approved media bytes that the URI serves. Registered recipes are immutable.

## Demo handoff

1. Use a disposable local volume for the Practice demo. Start as Guest, play a battle, reload and resume. Show the authoritative replay and the saved run ID.
2. For live multiplayer, use two authenticated sessions for a custom Veil Duel and three for co-op. Demonstrate turn ownership and reconnect. Ranked remains disabled pending fairness testing.
3. Review `docs/implementation/RELEASE_STATUS.md` for the latest verified testnet transactions and remaining gates before using live assets. Capture a transaction hash and a finalized receipt for any funded action shown in the demo.
4. Record browser acceptance and deployment evidence separately. A local container health check does not establish availability at the public demo origin.

