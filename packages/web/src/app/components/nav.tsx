export function Nav() {
  return (
    <nav className="fixed top-0 z-50 w-full border-b border-surface-200/50 bg-surface-0/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <a href="#" className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-taiko-300">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="white"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 2L2 7l10 5 10-5-10-5z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
          </div>
          <span className="text-lg font-bold tracking-tight text-surface-900">Servo</span>
        </a>
        <div className="hidden items-center gap-8 md:flex">
          <a
            href="#how-it-works"
            className="text-sm font-medium text-surface-500 transition-colors hover:text-surface-900"
          >
            How it works
          </a>
          <a
            href="#pricing"
            className="text-sm font-medium text-surface-500 transition-colors hover:text-surface-900"
          >
            Pricing
          </a>
          <a
            href="#comparison"
            className="text-sm font-medium text-surface-500 transition-colors hover:text-surface-900"
          >
            Compare
          </a>
          <a
            href="#integrate"
            className="rounded-lg bg-taiko-300 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-taiko-400"
          >
            Use with your agent
          </a>
        </div>
      </div>
    </nav>
  );
}
