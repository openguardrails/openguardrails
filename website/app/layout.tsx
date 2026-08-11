import type { Metadata } from "next";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import "./globals.css";

const TAGLINE = "Open runtime guardrails for AI agents";
const DESCRIPTION =
  "Open runtime guardrails for AI agents — one API, SDKs, and plugins that judge every " +
  "tool call, message, and syscall while the agent runs. Small models supervising models " +
  "100× their size, so people can hand real work to AI with confidence.";

export const metadata: Metadata = {
  title: {
    default: `OpenGuardrails — ${TAGLINE}`,
    template: "%s",
  },
  description: DESCRIPTION,
  keywords: [
    "runtime guardrails",
    "AI agent security",
    "agent guardrails",
    "guardrails API",
    "AI agent runtime security",
    "prompt injection",
    "MCP security",
    "LLM security",
    "agent safety",
    "weak-to-strong generalization",
  ],
  metadataBase: new URL("https://openguardrails.com"),
  alternates: { canonical: "./" },
  openGraph: {
    title: `OpenGuardrails — ${TAGLINE}`,
    description: DESCRIPTION,
    url: "https://openguardrails.com",
    siteName: "OpenGuardrails",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: `OpenGuardrails — ${TAGLINE}`,
    description: DESCRIPTION,
  },
  robots: { index: true, follow: true },
};

const JSON_LD = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      name: "OpenGuardrails",
      url: "https://openguardrails.com",
      logo: "https://openguardrails.com/logo.svg",
      description: DESCRIPTION,
      sameAs: [
        "https://github.com/openguardrails/openguardrails",
        "https://flaw0.com",
        "https://malware0.com",
      ],
    },
    {
      "@type": "WebSite",
      name: "OpenGuardrails",
      url: "https://openguardrails.com",
      description: TAGLINE,
    },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="scroll-smooth">
      <body className="min-h-screen flex flex-col">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }}
        />
        <Header />
        <div className="flex-1">{children}</div>
        <Footer />
      </body>
    </html>
  );
}
