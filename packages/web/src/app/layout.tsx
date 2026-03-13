import { Inter, JetBrains_Mono } from "next/font/google";
import type { Metadata } from "next";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const jetBrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Servo — The Agent-Native Paymaster",
  description:
    "Pay gas in USDC on Taiko. Zero setup. Agent-native. The only ERC-4337 paymaster and bundler on Taiko Alethia.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${inter.variable} ${jetBrainsMono.variable} bg-surface-0 text-surface-900 antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
