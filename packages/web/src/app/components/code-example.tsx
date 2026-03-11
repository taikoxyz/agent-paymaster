const codeString = `import { ServoClient } from "@servo/sdk";

const servo = new ServoClient({
  rpcUrl: "https://rpc.servo.dev",
  chainId: 167000, // Taiko Alethia
});

// 1. Get a USDC gas quote
const quote = await servo.getQuote({
  sender: smartAccount.address,
  callData: encodedTransaction,
});
// → { usdcCost: "0.042", gasEstimate: 85000n }

// 2. Build the UserOperation with paymaster data
const userOp = await servo.buildUserOp({
  sender: smartAccount.address,
  callData: encodedTransaction,
  quote,
});

// 3. Send it
const hash = await servo.sendUserOp(userOp);
// → "0x8a3f...e91b"`;

export function CodeExample() {
  return (
    <section className="py-24 md:py-32">
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
              Three function calls. Get a quote, build the operation, send it.
              Our SDK handles paymaster signatures, gas estimation, and permit
              construction under the hood.
            </p>
            <div className="mt-8 space-y-4">
              {[
                "Typed responses — full TypeScript support",
                "EIP-2612 permit helper built in",
                "Works with any ERC-4337 smart account",
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
                <span className="ml-3 text-xs font-medium text-surface-400">
                  agent.ts
                </span>
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
