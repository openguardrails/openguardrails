import type { Metadata } from "next";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import "./globals.css";

export const metadata: Metadata = {
  title: "OpenGuardrails",
  description:
    "The open guardrails layer for AI agents — one API, SDKs, and plugins to observe and stop unsafe agent actions.",
  keywords: [
    "AI agent security",
    "agent guardrails",
    "guardrails API",
    "prompt injection",
    "MCP security",
    "LLM security",
    "agent safety",
  ],
  metadataBase: new URL("https://openguardrails.com"),
  openGraph: {
    title: "OpenGuardrails",
    description:
      "The open guardrails layer for AI agents — one API, SDKs, and plugins to observe and stop unsafe agent actions.",
    url: "https://openguardrails.com",
    siteName: "OpenGuardrails",
    type: "website",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="scroll-smooth">
      <body className="min-h-screen flex flex-col">
        <Header />
        <div className="flex-1">{children}</div>
        <Footer />
      </body>
    </html>
  );
}
