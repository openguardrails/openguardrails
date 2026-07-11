import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OpenGuardrails — the open standard & benchmark for AI agent safety & security",
  description:
    "A vendor-neutral protocol that lets any agent, sandbox, and LLM use any safety/security vendor — and a neutral benchmark that ranks them.",
  keywords: [
    "AI agent security",
    "agent safety standard",
    "prompt injection",
    "MCP security",
    "guardrails benchmark",
    "agent guardrails standard",
    "LLM security",
  ],
  metadataBase: new URL("https://openguardrails.com"),
  openGraph: {
    title: "OpenGuardrails — the open standard for AI agent safety & security",
    description:
      "One protocol for every agent, sandbox, and LLM. One benchmark that ranks every vendor.",
    url: "https://openguardrails.com",
    siteName: "OpenGuardrails",
    type: "website",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="scroll-smooth">
      <body>{children}</body>
    </html>
  );
}
