# CallGasEstimator: Simulation-Based Call Gas Estimation

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the heuristic-only `callGasLimit` estimation (calldata-size based) with `eth_estimateGas` simulation that measures actual execution cost, fixing 3x+ underestimates for complex calls like ERC-8004 NFT registrations.

**Architecture:** New `CallGasEstimator` interface + `ViemCallGasEstimator` implementation, plugged into the existing `BundlerService.estimateUserOperationGas()` pipeline alongside the existing `GasSimulator` (which handles verification gas). Simulation calls `eth_estimateGas({ from: entryPoint, to: sender, data: callData })` with a 15% safety buffer. Falls back to heuristic × 3 when the account is undeployed or the RPC call fails.

**Tech Stack:** TypeScript, viem (`createPublicClient`, `estimateGas`), Vitest

---

## File Map

| Action | File                                 | Responsibility                                                                                                                                                                    |
| ------ | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Modify | `packages/bundler/src/index.ts`      | Add `CallGasEstimator` interface, `ViemCallGasEstimator` class, wire into `BundlerService` constructor + `estimateUserOperationGas`, wire into production `createBundlerApp` boot |
| Modify | `packages/bundler/src/index.test.ts` | Add unit tests for `CallGasEstimator` integration                                                                                                                                 |

No changes to `entrypoint.ts`, `paymaster-service.ts`, `shared/`, `submitter.ts`, or any Solidity.

---

### Task 1: Add `CallGasEstimator` interface and config wiring

**Files:**

- Modify: `packages/bundler/src/index.ts:320-326` (near existing `GasSimulator` interface)
- Modify: `packages/bundler/src/index.ts:275-296` (`BundlerConfigInput`)
- Modify: `packages/bundler/src/index.ts:639-689` (`BundlerService` constructor)

- [ ] **Step 1: Add `CallGasEstimator` interface after `GasSimulator` (line ~327)**

```typescript
export interface CallGasEstimator {
  estimateCallGas(
    sender: HexString,
    callData: HexString,
    entryPoint: HexString,
  ): Promise<bigint | null>;
}
```

Returns the buffered `callGasLimit` estimate, or `null` if estimation is unavailable (account not deployed, RPC error). Callers use `null` as a signal to fall back to heuristic.

- [ ] **Step 2: Add config fields to `BundlerConfigInput` (after line ~295)**

```typescript
  callGasEstimator?: CallGasEstimator;
  callGasBufferPercent?: bigint;
  callGasHeuristicMultiplier?: bigint;
```

- [ ] **Step 3: Add config fields to `BundlerConfig` (after line ~318)**

```typescript
callGasBufferPercent: bigint;
callGasHeuristicMultiplier: bigint;
```

- [ ] **Step 4: Wire defaults in `BundlerService` constructor (after line ~681)**

Add to the `this.config` assignment:

```typescript
      callGasBufferPercent: config.callGasBufferPercent ?? 15n,
      callGasHeuristicMultiplier: config.callGasHeuristicMultiplier ?? 3n,
```

Store the estimator as a private field (after `this.admissionSimulator` on line ~682):

```typescript
this.callGasEstimator = config.callGasEstimator;
```

- [ ] **Step 5: Declare the private field on `BundlerService` (after line ~647)**

```typescript
  private readonly callGasEstimator?: CallGasEstimator;
```

- [ ] **Step 6: Run build to verify no type errors**

Run: `cd /Users/gustavo/apps/agent-paymaster && pnpm --filter @agent-paymaster/bundler build`
Expected: Build succeeds with no errors

- [ ] **Step 7: Run existing tests to verify no regressions**

Run: `cd /Users/gustavo/apps/agent-paymaster && pnpm --filter @agent-paymaster/bundler test`
Expected: All existing tests pass unchanged

- [ ] **Step 8: Commit**

```bash
git add packages/bundler/src/index.ts
git commit -m "feat(bundler): add CallGasEstimator interface and config wiring"
```

---

### Task 2: Implement `ViemCallGasEstimator`

**Files:**

- Modify: `packages/bundler/src/index.ts:597-598` (after `ViemGasSimulator`, before `ViemAdmissionSimulator`)

- [ ] **Step 1: Write the `ViemCallGasEstimator` class**

Insert after the `ViemGasSimulator` class (after line ~597):

```typescript
export class ViemCallGasEstimator implements CallGasEstimator {
  private readonly publicClient;
  private readonly bufferPercent: bigint;

  constructor(rpcUrl: string, chain?: Chain, bufferPercent = 15n) {
    this.publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl),
    });
    this.bufferPercent = bufferPercent;
  }

  async estimateCallGas(
    sender: HexString,
    callData: HexString,
    entryPoint: HexString,
  ): Promise<bigint | null> {
    // Skip estimation for empty callData (no inner execution)
    if (callData === "0x" || callData === "0x00") {
      return null;
    }

    // Check if sender contract exists (undeployed accounts can't be simulated)
    const code = await this.publicClient.getCode({ address: sender });
    if (code === undefined || code === "0x") {
      return null;
    }

    try {
      const estimatedGas = await this.publicClient.estimateGas({
        account: entryPoint,
        to: sender,
        data: callData,
      });

      // Apply safety buffer for EntryPoint overhead:
      // - 1/64 gas lost at EntryPoint → account call boundary (EIP-150)
      // - EntryPoint bookkeeping gas around the call (~3-5K)
      const buffered = estimatedGas + (estimatedGas * this.bufferPercent) / 100n;
      return buffered;
    } catch (error) {
      logEvent("warn", "bundler.call_gas_estimation_failed", {
        sender,
        reason: error instanceof Error ? error.message : "estimation_failed",
      });
      return null;
    }
  }
}
```

- [ ] **Step 2: Run build to verify the class compiles**

Run: `cd /Users/gustavo/apps/agent-paymaster && pnpm --filter @agent-paymaster/bundler build`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add packages/bundler/src/index.ts
git commit -m "feat(bundler): implement ViemCallGasEstimator with eth_estimateGas"
```

---

### Task 3: Integrate `CallGasEstimator` into `estimateUserOperationGas`

**Files:**

- Modify: `packages/bundler/src/index.ts:861-941` (`estimateUserOperationGas` method)

- [ ] **Step 1: Add call gas estimation after the heuristic baseline and before the return**

Replace the current `callGasLimit` flow (lines 873-876 and 934-940) with simulation-aware logic. The full updated method body should be:

After the existing heuristic computation of `callGasLimit` (line 876), and after the `gasSimulator` block (line 932), add the call gas estimation block before the return statement (before line 934):

```typescript
// Call gas estimation: replace heuristic with simulation when available
if (this.callGasEstimator !== undefined && userOperation.callGasLimit === undefined) {
  try {
    const simulatedCallGas = await this.callGasEstimator.estimateCallGas(
      userOperation.sender,
      userOperation.callData,
      entryPoint,
    );
    if (simulatedCallGas !== null) {
      callGasLimit = simulatedCallGas;
    } else {
      // Estimation unavailable (undeployed account or empty callData) — scale heuristic
      callGasLimit = callGasLimit * this.config.callGasHeuristicMultiplier;
    }
  } catch (error) {
    logEvent("warn", "bundler.call_gas_estimator_error", {
      entryPoint,
      sender: userOperation.sender,
      reason: error instanceof Error ? error.message : "call_gas_estimation_error",
    });
    // Estimator threw unexpectedly — scale heuristic as fallback
    callGasLimit = callGasLimit * this.config.callGasHeuristicMultiplier;
  }
}
```

**Important:** The declaration at line 873 is `const callGasLimit`. You must change it to `let callGasLimit` so the reassignment in this block compiles.

**Note on ordering:** The `baseline` object (line 904) is constructed _before_ this block and uses the heuristic `callGasLimit`. This is intentional — `gasSimulator.estimatePreOpGas()` uses `baseline` for `simulateValidation`, which only depends on verification gas, not `callGasLimit`.

- [ ] **Step 2: Run build**

Run: `cd /Users/gustavo/apps/agent-paymaster && pnpm --filter @agent-paymaster/bundler build`
Expected: Build succeeds

- [ ] **Step 3: Run existing tests — expect some to fail**

Run: `cd /Users/gustavo/apps/agent-paymaster && pnpm --filter @agent-paymaster/bundler test`
Expected: Existing gas estimation tests still pass (they don't configure a `callGasEstimator`, so the new code path is skipped). All tests should still pass.

- [ ] **Step 4: Commit**

```bash
git add packages/bundler/src/index.ts
git commit -m "feat(bundler): integrate CallGasEstimator into gas estimation pipeline"
```

---

### Task 4: Add unit tests for `CallGasEstimator` integration

**Files:**

- Modify: `packages/bundler/src/index.test.ts`

- [ ] **Step 1: Add `FakeCallGasEstimator` mock class (after `ThrowingGasSimulator`, line ~63)**

```typescript
class FakeCallGasEstimator implements CallGasEstimator {
  constructor(private readonly result: bigint | null) {}

  estimateCallGas(
    _sender: `0x${string}`,
    _callData: `0x${string}`,
    _entryPoint: `0x${string}`,
  ): Promise<bigint | null> {
    void _sender;
    void _callData;
    void _entryPoint;
    return Promise.resolve(this.result);
  }
}

class ThrowingCallGasEstimator implements CallGasEstimator {
  estimateCallGas(
    _sender: `0x${string}`,
    _callData: `0x${string}`,
    _entryPoint: `0x${string}`,
  ): Promise<bigint | null> {
    void _sender;
    void _callData;
    void _entryPoint;
    throw new Error("eth_estimateGas unavailable");
  }
}
```

- [ ] **Step 2: Update the import to include `CallGasEstimator`**

Update line 6-13 to add `CallGasEstimator`:

```typescript
import {
  type AdmissionSimulator,
  BundlerService,
  createBundlerApp,
  type BundlerPersistence,
  type CallGasEstimator,
  type HexString,
  type GasSimulator,
  type UserOperation,
} from "./index.js";
```

- [ ] **Step 3: Add test — simulation replaces heuristic callGasLimit**

Add in the `estimateUserOperationGas` describe block (after the existing gas estimation tests, around line ~573):

```typescript
it("uses call gas estimator when available", async () => {
  const serviceWithCallGas = new BundlerService({
    chainId: 167000,
    entryPoints: [ENTRY_POINT_V07],
    callGasEstimator: new FakeCallGasEstimator(200_000n),
  });

  const estimate = await serviceWithCallGas.estimateUserOperationGas(
    buildUserOperation(),
    ENTRY_POINT_V07,
  );

  // 200000 = 0x30d40
  expect(estimate.callGasLimit).toBe("0x30d40");
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/gustavo/apps/agent-paymaster && pnpm --filter @agent-paymaster/bundler test`
Expected: New test passes. `callGasLimit` is `0x30d40` (200,000) instead of the heuristic `0xd6f8` (55,032).

- [ ] **Step 5: Add test — estimator returns null triggers heuristic × multiplier**

```typescript
it("scales heuristic when call gas estimator returns null", async () => {
  const serviceWithNullEstimator = new BundlerService({
    chainId: 167000,
    entryPoints: [ENTRY_POINT_V07],
    callGasEstimator: new FakeCallGasEstimator(null),
  });

  const estimate = await serviceWithNullEstimator.estimateUserOperationGas(
    buildUserOperation(),
    ENTRY_POINT_V07,
  );

  // Heuristic: 55000 + 2*16 = 55032. Multiplied by 3: 165096 = 0x284e8
  expect(estimate.callGasLimit).toBe("0x284e8");
});
```

- [ ] **Step 6: Run test to verify**

Run: `cd /Users/gustavo/apps/agent-paymaster && pnpm --filter @agent-paymaster/bundler test`
Expected: PASS

- [ ] **Step 7: Add test — estimator throws triggers heuristic × multiplier**

```typescript
it("scales heuristic when call gas estimator throws", async () => {
  const serviceWithThrowingEstimator = new BundlerService({
    chainId: 167000,
    entryPoints: [ENTRY_POINT_V07],
    callGasEstimator: new ThrowingCallGasEstimator(),
  });

  const estimate = await serviceWithThrowingEstimator.estimateUserOperationGas(
    buildUserOperation(),
    ENTRY_POINT_V07,
  );

  // Same as null case — heuristic × 3
  expect(estimate.callGasLimit).toBe("0x284e8");
});
```

- [ ] **Step 8: Run test to verify**

Run: `cd /Users/gustavo/apps/agent-paymaster && pnpm --filter @agent-paymaster/bundler test`
Expected: PASS

- [ ] **Step 9: Add test — client-provided callGasLimit is respected (not overridden)**

```typescript
it("respects client-provided callGasLimit even with call gas estimator", async () => {
  const serviceWithCallGas = new BundlerService({
    chainId: 167000,
    entryPoints: [ENTRY_POINT_V07],
    callGasEstimator: new FakeCallGasEstimator(200_000n),
  });

  const estimate = await serviceWithCallGas.estimateUserOperationGas(
    buildUserOperation({ callGasLimit: "0x50000" }),
    ENTRY_POINT_V07,
  );

  // Client provided 0x50000 (327680) — should be used as-is
  expect(estimate.callGasLimit).toBe("0x50000");
});
```

- [ ] **Step 10: Run test to verify**

Run: `cd /Users/gustavo/apps/agent-paymaster && pnpm --filter @agent-paymaster/bundler test`
Expected: PASS

- [ ] **Step 11: Add test — custom buffer percent and heuristic multiplier**

```typescript
it("applies custom buffer percent and heuristic multiplier", async () => {
  const serviceWithCustomConfig = new BundlerService({
    chainId: 167000,
    entryPoints: [ENTRY_POINT_V07],
    callGasEstimator: new FakeCallGasEstimator(null),
    callGasHeuristicMultiplier: 5n,
  });

  const estimate = await serviceWithCustomConfig.estimateUserOperationGas(
    buildUserOperation(),
    ENTRY_POINT_V07,
  );

  // Heuristic: 55032. Multiplied by 5: 275160 = 0x432d8
  expect(estimate.callGasLimit).toBe("0x432d8");
});
```

- [ ] **Step 12: Run full test suite**

Run: `cd /Users/gustavo/apps/agent-paymaster && pnpm --filter @agent-paymaster/bundler test`
Expected: ALL tests pass (new + existing)

- [ ] **Step 13: Commit**

```bash
git add packages/bundler/src/index.test.ts
git commit -m "test(bundler): add CallGasEstimator integration tests"
```

---

### Task 5: Wire `ViemCallGasEstimator` into production boot

**Files:**

- Modify: `packages/bundler/src/index.ts:2094-2108` (production boot block)

- [ ] **Step 1: Add `callGasEstimator` to the `BundlerService` constructor call**

In the `createBundlerApp` production block (line ~2094), add `callGasEstimator` alongside the existing `gasSimulator`:

```typescript
const service = new BundlerService(
  {
    chainId,
    acceptUserOperations: submissionEnabled,
    maxFinalizedOperations: parsePositiveIntegerWithFallback(
      process.env.BUNDLER_MAX_FINALIZED_OPERATIONS,
      10_000,
    ),
    gasSimulator: new ViemGasSimulator(chainRpcUrl, chain),
    callGasEstimator: new ViemCallGasEstimator(chainRpcUrl, chain),
    admissionSimulator: submissionEnabled
      ? new ViemAdmissionSimulator(chainRpcUrl, chain)
      : undefined,
  },
  persistence,
);
```

- [ ] **Step 2: Run build**

Run: `cd /Users/gustavo/apps/agent-paymaster && pnpm build`
Expected: Full workspace builds successfully

- [ ] **Step 3: Run full test suite**

Run: `cd /Users/gustavo/apps/agent-paymaster && pnpm test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add packages/bundler/src/index.ts
git commit -m "feat(bundler): wire ViemCallGasEstimator into production boot"
```

---

### Task 6: Update exports and verify integration

**Files:**

- Modify: `packages/bundler/src/index.ts` (exports)

- [ ] **Step 1: Verify `CallGasEstimator` and `ViemCallGasEstimator` are exported**

Check that both are accessible from the package. The interface and class should already be exported by virtue of `export interface` / `export class`. Verify with build.

- [ ] **Step 2: Run lint and format**

Run: `cd /Users/gustavo/apps/agent-paymaster && pnpm lint && pnpm format:write`
Expected: No lint errors. Formatter may adjust whitespace.

- [ ] **Step 3: Run the full check gate**

Run: `cd /Users/gustavo/apps/agent-paymaster && pnpm check`
Expected: All checks pass (lint + format + build + test)

- [ ] **Step 4: Commit any formatting changes**

```bash
git add -A
git commit -m "style(bundler): format after call gas estimator changes"
```

---

### Task 7: Update documentation

**Files:**

- Modify: `CLAUDE.md`
- Modify: `README.md` (if it documents gas estimation)

- [ ] **Step 1: Add note to CLAUDE.md Architecture section**

In the "Architecture (How It Works)" section, update step 2 to mention simulation:

> `pm_getPaymasterData` via `POST /rpc` → API asks bundler for simulation-backed gas limits (heuristic + EntryPoint `simulateValidation` pre-op gas + `eth_estimateGas` call gas), prices via oracle, returns EIP-712 signed `paymasterAndData`

- [ ] **Step 2: Add `BUNDLER_CALL_GAS_BUFFER_PERCENT` to Config Defaults table if env var is added**

If no env var is added (buffer is hardcoded in class constructor), skip this step. The current design passes the buffer via the `ViemCallGasEstimator` constructor (default 15), so no env var is needed.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document call gas simulation in architecture"
```
