const codeString = `import { createClient, http } from "viem";
import { taikoAlethia } from "viem/chains";

const client = createClient({
  chain: taikoAlethia,
  transport: http("https://servo.taiko.xyz/rpc"),
});

// 1. Get stub data to learn the USDC cost
const stub = await client.request({
  method: "pm_getPaymasterStubData",
  params: [userOp, entryPoint, "0x28C70", {}],
});
// stub.maxTokenCost → "2370000" (2.37 USDC)

// 2. Sign an EIP-2612 permit for that cost
const permit = await walletClient.signTypedData({
  domain: { name: "USD Coin", version: "2",
    chainId: 167000,
    verifyingContract: USDC_ADDRESS },
  types: { Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ]},
  primaryType: "Permit",
  message: {
    owner: account.address,
    spender: stub.paymaster,
    value: BigInt(stub.maxTokenCost),
    nonce: 0n,
    deadline: BigInt(stub.validUntil),
  },
});

// 3. Get final paymasterData with the permit
const result = await client.request({
  method: "pm_getPaymasterData",
  params: [userOp, entryPoint, "0x28C70", { permit }],
});
// result.paymasterData → ready to use`;

const integrationDetails = [
  { label: "RPC endpoint", value: "https://servo.taiko.xyz/rpc" },
  { label: "Standard", value: "ERC-7677 (pm_getPaymasterData)" },
  { label: "Chain", value: "Taiko Alethia (167000)" },
  { label: "EntryPoint", value: "0x0000000071727De22E5E9d8BAf0edAc6f37da032" },
];

export function CodeExample() {
  return (
    <section id="integrate" className="py-24 md:py-32">
      <div className="mx-auto max-w-6xl px-6">
        <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
          {/* Left: Text */}
          <div>
            <h2 className="text-3xl font-bold tracking-tight text-surface-900 md:text-4xl">
              Dead simple
              <br />
              <span className="text-surface-500">to integrate.</span>
            </h2>
            <p className="mt-6 text-lg leading-relaxed text-surface-500">
              Point your agent at{" "}
              <code className="rounded bg-surface-100 px-1.5 py-0.5 font-mono text-sm text-servo-400">
                https://servo.taiko.xyz/rpc
              </code>{" "}
              and tell it to use Servo as its paymaster when it needs to transact on Taiko. Standard
              ERC-7677 — no SDK, no proprietary abstractions.
            </p>
            <div className="mt-8 space-y-4">
              {[
                "Standard ERC-7677 — works with any compliant client",
                "Pure viem — no SDK or wrapper needed",
                "Works with any ERC-4337 smart account",
                "Your agent only needs USDC — no ETH at any point",
              ].map((feature) => (
                <div key={feature} className="flex items-center gap-3">
                  <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-servo-500/15">
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                      className="text-servo-400"
                    >
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </div>
                  <span className="text-sm text-surface-600">{feature}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Right: Code block */}
          <div className="relative">
            <div className="absolute -inset-4 rounded-3xl bg-servo-500/5 blur-2xl" />
            <div className="relative overflow-hidden rounded-2xl border border-surface-200 bg-surface-50">
              {/* Window chrome */}
              <div className="flex items-center gap-2 border-b border-surface-200 px-4 py-3">
                <div className="h-3 w-3 rounded-full bg-surface-300/50" />
                <div className="h-3 w-3 rounded-full bg-surface-300/50" />
                <div className="h-3 w-3 rounded-full bg-surface-300/50" />
                <span className="ml-3 text-xs font-medium text-surface-400">agent.ts</span>
              </div>
              {/* Code */}
              <pre className="overflow-x-auto p-6 text-[13px] leading-relaxed">
                <code className="font-mono text-surface-600">{codeString}</code>
              </pre>
            </div>
          </div>
        </div>

        {/* Integration details */}
        <div className="mt-16 rounded-2xl border border-surface-200 bg-surface-50 p-6 md:p-8">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-surface-500">
            Integration details
          </h3>
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            {integrationDetails.map((detail) => (
              <div key={detail.label}>
                <div className="text-xs font-medium text-surface-400">{detail.label}</div>
                <div className="mt-1 font-mono text-sm text-surface-700 break-all">
                  {detail.value}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
