export function Hero() {
  return (
    <section className="relative overflow-hidden pt-32 pb-20 md:pt-44 md:pb-32">
      {/* Gradient background */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute top-0 left-1/2 h-[600px] w-[900px] -translate-x-1/2 rounded-full bg-servo-500/8 blur-3xl" />
        <div className="absolute top-40 left-1/4 h-[300px] w-[400px] rounded-full bg-servo-400/5 blur-3xl" />
      </div>

      <div className="relative mx-auto max-w-6xl px-6">
        {/* Badge */}
        <div className="mb-8 flex justify-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-servo-500/20 bg-servo-500/10 px-4 py-1.5">
            <div className="h-1.5 w-1.5 rounded-full bg-servo-400 animate-pulse" />
            <span className="text-xs font-medium tracking-wide text-servo-400">
              First paymaster on Taiko Alethia
            </span>
          </div>
        </div>

        {/* Headline */}
        <h1 className="mx-auto max-w-3xl text-center text-4xl font-extrabold leading-[1.1] tracking-tight text-surface-900 sm:text-5xl md:text-6xl">
          Pay gas in USDC.
          <br />
          <span className="bg-gradient-to-r from-servo-400 to-servo-600 bg-clip-text text-transparent">
            Zero native tokens.
          </span>
        </h1>

        {/* Subheadline */}
        <p className="mx-auto mt-6 max-w-xl text-center text-lg leading-relaxed text-surface-500 md:text-xl">
          The agent-native ERC-4337 paymaster and bundler for Taiko. Your agents
          pay gas in USDC — no ETH, no bridging, no setup.
        </p>

        {/* CTAs */}
        <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
          <a
            href="#"
            className="group inline-flex items-center gap-2 rounded-xl bg-servo-500 px-7 py-3.5 text-sm font-semibold text-white shadow-lg shadow-servo-500/25 transition-all hover:bg-servo-600 hover:shadow-servo-500/40"
          >
            Start building
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="transition-transform group-hover:translate-x-0.5"
            >
              <path d="M5 12h14" />
              <path d="m12 5 7 7-7 7" />
            </svg>
          </a>
          <a
            href="#how-it-works"
            className="inline-flex items-center gap-2 rounded-xl border border-surface-200 bg-surface-50 px-7 py-3.5 text-sm font-semibold text-surface-700 transition-all hover:border-surface-300 hover:bg-surface-100"
          >
            See how it works
          </a>
        </div>

        {/* Stats */}
        <div className="mx-auto mt-20 grid max-w-2xl grid-cols-3 gap-8">
          {[
            { value: "5%", label: "Gas surcharge" },
            { value: "1K", label: "Free ops/month" },
            { value: "~2s", label: "Confirmation time" },
          ].map((stat) => (
            <div key={stat.label} className="text-center">
              <div className="text-2xl font-bold text-surface-900 md:text-3xl">
                {stat.value}
              </div>
              <div className="mt-1 text-sm text-surface-500">{stat.label}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
