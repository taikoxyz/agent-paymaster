# Servo — Production Migration Checklist

> Moves the system from the single leaked testing wallet onto a two-key model:
> **admin = multisig**, **ops = fresh EOA** (bundler submitter + quote signer combined).

## Addresses

| Handle | Address | Role after migration |
|---|---|---|
| `$MULTISIG` | `0x8Ba87a7C5908d0bE9fd86640F87976AB6e5E80E4` | `DEFAULT_ADMIN_ROLE` + `MANAGER_ROLE` on `ServoPaymaster` |
| `$OPS` | _tbd — fresh EOA, not yet generated_ | Bundler submitter + quote signer |
| `$OLD_ADMIN` | `0x2AB05c081B31B3882C1c0367D9b734e530237B15` | Retired after revoke. Leaked in an earlier session — must lose all roles before we call this done. |
| `$OLD_QUOTE_SIGNER` | `0x208cc91CE369E969d246DeBf2a78f28BdeebB9B8` | Retired once `$OPS` is live. |
| `$PM` (ServoPaymaster) | `0x15a5451FeDc348312F1B59F7D930D494B7A73393` | — |
| `$FACTORY` (ServoAccountFactory) | `0x27A8169f8C837D66497b4FD1002ef178F88cc1D6` | Not ownable; no action |
| EntryPoint | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` | — |
| USDC | `0x07d83526730c7438048D55A4fc0b850e2aaB6f0b` | — |

## Phase 1 — Grant roles to the multisig (`$OLD_ADMIN` still active)

Safe confirmed on Taiko 2026-04-14: v1.3.0, 4 owners, threshold 2.

- [x] 1.1 `ServoPaymaster.grantRole(DEFAULT_ADMIN_ROLE, $MULTISIG)` — tx `0xd010de08e1174f80ac8370f01bd7645d00804f3530e80a5c84c239c5e6755969`
- [x] 1.2 `ServoPaymaster.grantRole(MANAGER_ROLE, $MULTISIG)` — tx `0x2f764a3079b5e9fd1d370d57733f4ab44fababe106112232fede4ed234bedd3b`
- [x] 1.3 Verify `hasRole(DEFAULT_ADMIN_ROLE, $MULTISIG) == true`
- [x] 1.4 Verify `hasRole(MANAGER_ROLE, $MULTISIG) == true`

## Phase 2 — Provision the ops EOA

- [ ] 2.1 `cast wallet new` → write address into `$OPS`, store private key in GCP Secret Manager (`servo-ops-key`)
- [ ] 2.2 Fund `$OPS` with ~0.02 ETH from `$OLD_ADMIN`
- [ ] 2.3 `ServoPaymaster.addSigner($OPS)` — caller: `$OLD_ADMIN` (MANAGER_ROLE)
- [ ] 2.4 Verify `signers($OPS) == true`

## Phase 3 — Cut services over to `$OPS`

- [ ] 3.1 Railway `api`: set `PAYMASTER_QUOTE_SIGNER_PRIVATE_KEY = <ops key>`
- [ ] 3.2 Railway `bundler`: set `BUNDLER_SUBMITTER_PRIVATE_KEY = <ops key>`
- [ ] 3.3 Redeploy `api` service
- [ ] 3.4 Redeploy `bundler` service
- [ ] 3.5 `/status` reports `paymaster.signerAddress == $OPS`
- [ ] 3.6 Live cold-start UserOp via `/tmp/live-cold-start.ts` (fresh salt) — receipt success

## Phase 4 — Retire the old off-chain signer

- [ ] 4.1 `ServoPaymaster.removeSigner($OLD_QUOTE_SIGNER)` — caller: `$OLD_ADMIN` (MANAGER_ROLE) **or** `$MULTISIG`
- [ ] 4.2 Verify `signers($OLD_QUOTE_SIGNER) == false`
- [ ] 4.3 Verify a second live cold-start UserOp still works (regression check)

## Phase 5 — Drain the old testing wallet (non-gas funds)

- [ ] 5.1 Transfer all `$OLD_ADMIN` USDC → `$OPS` or `$MULTISIG`
- [ ] 5.2 Leave ~0.0005 ETH for the revoke txs in Phase 6

## Phase 6 — Revoke old admin roles (from `$MULTISIG`)

- [ ] 6.1 Safe tx: `ServoPaymaster.revokeRole(MANAGER_ROLE, $OLD_ADMIN)`
- [ ] 6.2 Safe tx: `ServoPaymaster.revokeRole(DEFAULT_ADMIN_ROLE, $OLD_ADMIN)`
- [ ] 6.3 Verify `hasRole(DEFAULT_ADMIN_ROLE, $OLD_ADMIN) == false`
- [ ] 6.4 Verify `hasRole(MANAGER_ROLE, $OLD_ADMIN) == false`
- [ ] 6.5 Verify `hasRole(DEFAULT_ADMIN_ROLE, $MULTISIG) == true` (unchanged)
- [ ] 6.6 Sweep remaining ETH from `$OLD_ADMIN` → `$OPS`

## Phase 7 — Stake the paymaster on EntryPoint (from `$MULTISIG`)

- [ ] 7.1 Confirm exact function name on `BaseSingletonPaymaster` (`addStake(uint32 unstakeDelaySec)` payable expected)
- [ ] 7.2 Safe tx: `ServoPaymaster.addStake(86400)` with `value = 0.05 ETH`
- [ ] 7.3 Verify `entryPoint.getDepositInfo($PM).stake > 0`

## Phase 8 — Docs & memory

- [ ] 8.1 Update `docs/deployment.md` admin / operator rows
- [ ] 8.2 Update `memory/project_mainnet_deployment.md`
- [ ] 8.3 Commit as `chore(ops): rotate keys to multisig + ops EOA`

## Post-migration monitoring (wire up)

- [ ] Alert: `RoleGranted` / `RoleRevoked` on `ServoPaymaster` → page
- [ ] Alert: `addSigner` / `removeSigner` on `ServoPaymaster` → page
- [ ] Alert: paymaster EntryPoint deposit < 0.003 ETH → warn
- [ ] Alert: `$OPS` ETH < 0.005 ETH → warn
- [ ] Alert: API `/status` degraded > 2 min → page
