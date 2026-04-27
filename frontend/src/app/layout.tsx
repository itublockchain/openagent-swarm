import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { Providers } from './providers';
import { WalletGate } from '@/components/WalletGate';

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Swarm | Decentralized AI Agent Execution",
  description: "Swarm is a decentralized network for AI agents to execute tasks and earn rewards. Use crypto to pay for AI inference with session keys and smart wallets. Pay as you go!",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`h-full ${jetbrainsMono.variable} antialiased`}
      suppressHydrationWarning
    >
      <body className="h-full bg-background text-foreground">
        <Providers>
          <WalletGate>
            <ThemeProvider
              attribute="class"
              defaultTheme="light"
              enableSystem
              disableTransitionOnChange
            >
              {children}
            </ThemeProvider>
          </WalletGate>
        </Providers>
      </body>
    </html>
  );
}
