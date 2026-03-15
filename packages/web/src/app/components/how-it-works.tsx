const steps = [
  {
    number: "01",
    title: "Get a USDC quote",
    description:
      "Call our paymaster endpoint with your UserOperation. We return the exact USDC cost including gas estimate — no surprises.",
    icon: (
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8" />
        <path d="M12 18V6" />
      </svg>
    ),
  },
  {
    number: "02",
    title: "Sign a USDC permit",
    description:
      "Approve the USDC spend with an EIP-2612 off-chain signature. No on-chain approval transaction needed — zero ETH required at any point.",
    icon: (
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
        <path d="m9 12 2 2 4-4" />
      </svg>
    ),
  },
  {
    number: "03",
    title: "Submit & done",
    description:
      "Send the UserOperation through our bundler. We handle gas payment, bundling, and on-chain execution. Your agent moves on.",
    icon: (
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
        <polyline points="22 4 12 14.01 9 11.01" />
      </svg>
    ),
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="py-24 md:py-32">
      <div className="mx-auto max-w-6xl px-6">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight text-surface-900 md:text-4xl">
            Three steps. That&apos;s it.
          </h2>
          <p className="mt-4 text-lg text-surface-500">
            No ETH bridging. No token wrapping. No gas management headaches.
          </p>
        </div>

        <div className="mt-16 grid gap-6 md:grid-cols-3 md:gap-8">
          {steps.map((step) => (
            <div
              key={step.number}
              className="group relative rounded-2xl border border-surface-200 bg-surface-50 p-8 transition-all hover:border-taiko-300/30 hover:bg-surface-100"
            >
              <div className="mb-6 flex items-center justify-between">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-taiko-300/10 text-taiko-200 transition-colors group-hover:bg-taiko-300/15">
                  {step.icon}
                </div>
                <span className="text-sm font-bold text-surface-300">{step.number}</span>
              </div>
              <h3 className="text-xl font-semibold text-surface-900">{step.title}</h3>
              <p className="mt-3 text-sm leading-relaxed text-surface-500">{step.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
