export function Cta() {
  return (
    <section className="py-24 md:py-32">
      <div className="mx-auto max-w-6xl px-6">
        <div className="relative overflow-hidden rounded-3xl border border-surface-200 bg-surface-50">
          {/* Gradient */}
          <div className="pointer-events-none absolute inset-0">
            <div className="absolute -top-20 -right-20 h-[400px] w-[400px] rounded-full bg-servo-500/10 blur-3xl" />
            <div className="absolute -bottom-20 -left-20 h-[300px] w-[300px] rounded-full bg-servo-400/8 blur-3xl" />
          </div>

          <div className="relative px-8 py-16 text-center md:px-16 md:py-24">
            <h2 className="text-3xl font-bold tracking-tight text-surface-900 md:text-4xl">
              Ready to build on Taiko?
            </h2>
            <p className="mx-auto mt-4 max-w-lg text-lg text-surface-500">
              Start sending gasless UserOperations in minutes. Free tier
              included — no signup required.
            </p>
            <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
              <a
                href="#"
                className="group inline-flex items-center gap-2 rounded-xl bg-servo-500 px-7 py-3.5 text-sm font-semibold text-white shadow-lg shadow-servo-500/25 transition-all hover:bg-servo-600 hover:shadow-servo-500/40"
              >
                Get your API key
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
                href="#"
                className="inline-flex items-center gap-2 rounded-xl border border-surface-200 bg-surface-50 px-7 py-3.5 text-sm font-semibold text-surface-700 transition-all hover:border-surface-300 hover:bg-surface-100"
              >
                Read the docs
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
