export function Pricing() {
  return (
    <section id="pricing" className="py-24 md:py-32">
      <div className="mx-auto max-w-6xl px-6">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight text-surface-900 md:text-4xl">
            Simple, transparent pricing
          </h2>
          <p className="mt-4 text-lg text-surface-500">
            Pay per operation. No subscriptions. No signup required.
          </p>
        </div>

        <div className="mx-auto mt-16 max-w-lg">
          <div className="relative rounded-2xl border border-servo-500/30 bg-surface-50 p-8 shadow-lg shadow-servo-500/5">
            <div className="text-sm font-semibold uppercase tracking-wider text-servo-400">
              Pay-per-use
            </div>
            <div className="mt-4 flex items-baseline gap-1">
              <span className="text-4xl font-extrabold text-surface-900">5%</span>
              <span className="text-surface-500">gas surcharge</span>
            </div>
            <p className="mt-4 text-sm text-surface-500">
              Every UserOp is priced in USDC and settled on-chain. No invoices, no billing cycles, no
              API keys.
            </p>
            <ul className="mt-8 space-y-3">
              {[
                "Unlimited UserOps",
                "Bundler + paymaster included",
                "Settled on-chain in USDC",
                "No signup or API keys",
                "No invoices or billing",
              ].map((item) => (
                <li key={item} className="flex items-center gap-3 text-sm">
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    className="shrink-0 text-servo-400"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span className="text-surface-600">{item}</span>
                </li>
              ))}
            </ul>
            <a
              href="#integrate"
              className="mt-8 block rounded-xl bg-servo-500 py-3 text-center text-sm font-semibold text-white transition-all hover:bg-servo-600"
            >
              Get started
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
