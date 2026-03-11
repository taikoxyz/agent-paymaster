export function Pricing() {
  return (
    <section id="pricing" className="py-24 md:py-32">
      <div className="mx-auto max-w-6xl px-6">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight text-surface-900 md:text-4xl">
            Simple, transparent pricing
          </h2>
          <p className="mt-4 text-lg text-surface-500">
            Pay per operation. No subscriptions. No commitments.
          </p>
        </div>

        <div className="mx-auto mt-16 grid max-w-4xl gap-6 md:grid-cols-2">
          {/* Free tier */}
          <div className="rounded-2xl border border-surface-200 bg-surface-50 p-8">
            <div className="text-sm font-semibold uppercase tracking-wider text-surface-500">
              Free tier
            </div>
            <div className="mt-4 flex items-baseline gap-1">
              <span className="text-4xl font-extrabold text-surface-900">
                $0
              </span>
              <span className="text-surface-500">/month</span>
            </div>
            <p className="mt-4 text-sm text-surface-500">
              Get started without a credit card. Perfect for testing and
              low-volume agents.
            </p>
            <ul className="mt-8 space-y-3">
              {[
                "1,000 UserOps per month",
                "Full bundler + paymaster access",
                "Standard gas estimation",
                "Community support",
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
              href="#"
              className="mt-8 block rounded-xl border border-surface-200 py-3 text-center text-sm font-semibold text-surface-700 transition-all hover:border-surface-300 hover:bg-surface-100"
            >
              Start free
            </a>
          </div>

          {/* Standard tier */}
          <div className="relative rounded-2xl border border-servo-500/30 bg-surface-50 p-8 shadow-lg shadow-servo-500/5">
            <div className="absolute -top-3 right-8">
              <span className="rounded-full bg-servo-500 px-3 py-1 text-xs font-semibold text-white">
                Most popular
              </span>
            </div>
            <div className="text-sm font-semibold uppercase tracking-wider text-servo-400">
              Standard
            </div>
            <div className="mt-4 flex items-baseline gap-1">
              <span className="text-4xl font-extrabold text-surface-900">
                5%
              </span>
              <span className="text-surface-500">gas surcharge</span>
            </div>
            <p className="mt-4 text-sm text-surface-500">
              Pay-per-use after the free tier. Settled on-chain in USDC — no
              invoices, no billing cycles.
            </p>
            <ul className="mt-8 space-y-3">
              {[
                "Unlimited UserOps",
                "Priority bundling",
                "Real-time gas estimation",
                "Volume discounts at scale",
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
              href="#"
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
