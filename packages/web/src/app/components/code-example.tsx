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

const RPC_ENDPOINT = "https://api-production-cdfe.up.railway.app/rpc";

const integrationDetails = [
  { label: "Standard", value: "ERC-7677 (pm_getPaymasterData)" },
  { label: "Chain", value: "Taiko Alethia (167000)" },
  { label: "EntryPoint", value: "0x0000000071727De22E5E9d8BAf0edAc6f37da032" },
];

export function CodeExample() {
  return (
    <section id="integrate" className="py-24 md:py-32">
      <div className="mx-auto max-w-6xl px-6">
        {/* Agent-first CTA */}
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight text-surface-900 md:text-4xl">
            One endpoint.
            <br />
            <span className="text-surface-500">Give it to your agent.</span>
          </h2>
          <p className="mt-6 text-lg leading-relaxed text-surface-500">
            Tell your AI agent to use this URL as its paymaster when transacting on Taiko. It
            handles the rest — quoting, permits, submission. Standard{" "}
            <a
              href="https://eips.ethereum.org/EIPS/eip-7677"
              target="_blank"
              rel="noopener noreferrer"
              className="text-taiko-200 hover:text-taiko-100"
            >
              ERC-7677
            </a>
            , no SDK needed.
          </p>
        </div>

        {/* Prominent endpoint */}
        <div className="mx-auto mt-10 max-w-2xl">
          <div className="group relative rounded-2xl border border-taiko-300/30 bg-surface-50 p-6 shadow-lg shadow-taiko-300/5">
            <div className="text-xs font-semibold uppercase tracking-wider text-surface-400">
              Paymaster RPC endpoint
            </div>
            <div className="mt-3 flex items-center gap-3">
              <code className="flex-1 break-all font-mono text-lg text-surface-900">
                {RPC_ENDPOINT}
              </code>
            </div>
            <p className="mt-3 text-sm text-surface-400">
              All paymaster and bundler methods in one place. Your agent only needs USDC — no ETH at
              any point.
            </p>
          </div>
        </div>

        {/* Feature checklist */}
        <div className="mx-auto mt-8 flex max-w-2xl flex-wrap justify-center gap-x-8 gap-y-3">
          {[
            "Works with any ERC-4337 smart account",
            "Pure viem — no SDK or wrapper",
            "Agent only needs USDC",
            "No API keys or signup",
          ].map((feature) => (
            <div key={feature} className="flex items-center gap-2">
              <div className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-taiko-300/15">
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  className="text-taiko-200"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <span className="text-sm text-surface-500">{feature}</span>
            </div>
          ))}
        </div>

        {/* Code example */}
        <div className="mx-auto mt-16 grid max-w-6xl items-start gap-12 lg:grid-cols-2 lg:gap-16">
          {/* Left: integration details */}
          <div>
            <h3 className="text-xl font-semibold text-surface-900">If you want the details</h3>
            <p className="mt-3 text-sm leading-relaxed text-surface-500">
              Under the hood it&apos;s standard ERC-7677 JSON-RPC — get a quote, sign a USDC permit,
              submit. Here&apos;s the full flow with viem.
            </p>

            {/* Integration details */}
            <div className="mt-8 space-y-4">
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

          {/* Right: Code block */}
          <div className="relative">
            <div className="absolute -inset-4 rounded-3xl bg-taiko-300/5 blur-2xl" />
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
      </div>
    </section>
  );
}
