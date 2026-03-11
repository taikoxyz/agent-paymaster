import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Servo — The Agent-Native Paymaster",
  description:
    "Pay gas in USDC on Taiko. Zero setup. Agent-native. The only ERC-4337 paymaster and bundler on Taiko Alethia.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="bg-surface-0 text-surface-900 antialiased">
        {children}
      </body>
    </html>
  );
}
