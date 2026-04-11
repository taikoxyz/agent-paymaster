const codeString = `import { createClient, encodeFunctionData, http, maxUint256, parseAbi } from "viem";
import { taikoAlethia } from "viem/chains";

const client = createClient({
  chain: taikoAlethia,
  transport: http("https://servo.taiko.xyz/rpc"),
});

const accountAbi = parseAbi([
  "function execute(address,uint256,bytes)",
  "function executeBatch(address[] targets, uint256[] values, bytes[] calldatas)",
]);
const usdcAbi = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function nonces(address owner) view returns (uint256)",
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
]);

const action = encodeFunctionData({
  abi: targetAbi,
  functionName: "doThing",
  args: [123n],
});

let userOp = {
  sender,
  nonce: "0x0",
  initCode,
  callData: encodeFunctionData({
    abi: accountAbi,
    functionName: "execute",
    args: [target, 0n, action],
  }),
  callGasLimit: "0x0",
  verificationGasLimit: "0x0",
  preVerificationGas: "0x0",
  maxFeePerGas,
  maxPriorityFeePerGas,
  signature: DUMMY_SIG,
};

// 1. Stub quote for the real action. This reveals the paymaster + token + maxTokenCost.
const stub = await client.request({
  method: "pm_getPaymasterStubData",
  params: [userOp, entryPoint, "taikoMainnet"],
});

// 2. If the undeployed account has no allowance yet, prepend permit() in the same UserOp.
const allowance = await publicClient.readContract({
  address: stub.tokenAddress,
  abi: usdcAbi,
  functionName: "allowance",
  args: [sender, stub.paymaster],
});

if (allowance < BigInt(stub.maxTokenCostMicros)) {
  const permit = await signPermitWithViem({
    owner,
    token: stub.tokenAddress,
    spender: stub.paymaster,
    value: maxUint256,
    nonce: await publicClient.readContract({
      address: stub.tokenAddress,
      abi: usdcAbi,
      functionName: "nonces",
      args: [sender],
    }),
  });

  userOp = {
    ...userOp,
    callData: encodeFunctionData({
      abi: accountAbi,
      functionName: "executeBatch",
      args: [
        [stub.tokenAddress, target],
        [0n, 0n],
        [permit.calldata, action],
      ],
    }),
  };
}

// 3. Final quote for the exact UserOp you will submit.
const quote = await client.request({
  method: "pm_getPaymasterData",
  params: [userOp, entryPoint, "taikoMainnet"],
});

// 4. Sign the final UserOp hash and send it.
await bundlerClient.sendUserOperation({
  ...userOp,
  ...quote,
});`;

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
            Tell your AI agent to use this URL as its paymaster when transacting on Taiko. It only
            needs standard viem + ERC-7677 JSON-RPC. Fresh accounts fund the counterfactual address
            with USDC, then deploy and transact in one sponsored UserOp.{" "}
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
            "Fund the undeployed address first",
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
              Under the hood it&apos;s standard ERC-7677 JSON-RPC. The cold-start path is: stub
              quote, prepend `permit()` if allowance is missing, quote the final UserOp, submit.
              Here&apos;s the viem flow.
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
