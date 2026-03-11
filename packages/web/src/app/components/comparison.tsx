const providers = [
  {
    name: "Servo",
    highlight: true,
    features: {
      taiko: true,
      usdcGas: true,
      bundler: true,
      paymaster: true,
      permitFlow: true,
      pricing: "5%",
    },
  },
  {
    name: "Pimlico",
    highlight: false,
    features: {
      taiko: false,
      usdcGas: true,
      bundler: true,
      paymaster: true,
      permitFlow: false,
      pricing: "~15.5%",
    },
  },
  {
    name: "Circle",
    highlight: false,
    features: {
      taiko: false,
      usdcGas: true,
      bundler: false,
      paymaster: true,
      permitFlow: true,
      pricing: "10%",
    },
  },
  {
    name: "Alchemy",
    highlight: false,
    features: {
      taiko: false,
      usdcGas: false,
      bundler: true,
      paymaster: true,
      permitFlow: false,
      pricing: "8% + per-op",
    },
  },
];

const featureRows = [
  { key: "taiko" as const, label: "Taiko support" },
  { key: "usdcGas" as const, label: "USDC gas payment" },
  { key: "bundler" as const, label: "Bundler" },
  { key: "paymaster" as const, label: "Paymaster" },
  { key: "permitFlow" as const, label: "Permit flow (no ETH)" },
  { key: "pricing" as const, label: "Effective rate" },
];

function Cell({ value }: { value: boolean | string }) {
  if (typeof value === "string") {
    return <span className="text-sm font-medium text-surface-600">{value}</span>;
  }
  return value ? (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      className="text-servo-400"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  ) : (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="text-surface-400"
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

export function Comparison() {
  return (
    <section id="comparison" className="py-24 md:py-32">
      <div className="mx-auto max-w-6xl px-6">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight text-surface-900 md:text-4xl">
            The only option on Taiko
          </h2>
          <p className="mt-4 text-lg text-surface-500">
            No other paymaster or bundler supports Taiko Alethia. And we&apos;re
            cheaper than the competition on other chains.
          </p>
        </div>

        <div className="mt-16 overflow-x-auto">
          <table className="w-full min-w-[600px]">
            <thead>
              <tr className="border-b border-surface-200">
                <th className="pb-4 text-left text-sm font-medium text-surface-500" />
                {providers.map((p) => (
                  <th
                    key={p.name}
                    className={`pb-4 text-center text-sm font-semibold ${
                      p.highlight ? "text-servo-400" : "text-surface-600"
                    }`}
                  >
                    {p.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {featureRows.map((row) => (
                <tr
                  key={row.key}
                  className="border-b border-surface-200/50"
                >
                  <td className="py-4 text-sm text-surface-500">
                    {row.label}
                  </td>
                  {providers.map((p) => (
                    <td key={p.name} className="py-4 text-center">
                      <div className="flex justify-center">
                        <Cell value={p.features[row.key]} />
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
