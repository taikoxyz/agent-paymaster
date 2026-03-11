export function Footer() {
  return (
    <footer className="border-t border-surface-200/50 py-12">
      <div className="mx-auto max-w-6xl px-6">
        <div className="flex flex-col items-center justify-between gap-6 md:flex-row">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-servo-500">
              <svg
                width="14"
                height="14"
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
            <span className="text-sm font-semibold text-surface-700">
              Servo
            </span>
          </div>
          <div className="flex items-center gap-6">
            <a
              href="#"
              className="text-sm text-surface-500 transition-colors hover:text-surface-700"
            >
              Docs
            </a>
            <a
              href="#"
              className="text-sm text-surface-500 transition-colors hover:text-surface-700"
            >
              GitHub
            </a>
            <a
              href="#"
              className="text-sm text-surface-500 transition-colors hover:text-surface-700"
            >
              Status
            </a>
          </div>
          <p className="text-xs text-surface-400">
            Built on Taiko Alethia. Powered by ERC-4337.
          </p>
        </div>
      </div>
    </footer>
  );
}
