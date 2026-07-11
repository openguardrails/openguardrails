import type { Metadata } from "next";

const GH = "https://github.com/openguardrails";

export const metadata: Metadata = {
  title: "Donate — OpenGuardrails",
  description:
    "Fund AGI endgame safety. Donations to OpenGuardrails support the weak-over-strong supervision layer that keeps human authority over strong AI. Every dollar goes to the mission.",
};

// ─────────────────────────────────────────────────────────────────────────────
// STRIPE PAYMENT LINK
// Create one in the Stripe dashboard: Payments → Payment Links → New.
//   • To let donors choose the amount, set the price to "Customers choose what
//     to pay" (a.k.a. pay-what-you-want).
//   • Copy the resulting https://donate.stripe.com/… (or https://buy.stripe.com/…) URL
//     and paste it below.
// The preset buttons reuse this one link by default (the donor enters the amount
// on Stripe's page). If you'd rather have exact fixed-amount buttons, create one
// Payment Link per amount and set its `url` in PRESETS.
// ─────────────────────────────────────────────────────────────────────────────
const STRIPE_DONATE_URL = "https://donate.stripe.com/9B6dR909W7CSeTW6Li9oc00";

const PRESETS: { label: string; note?: string; url: string }[] = [
  { label: "$25", url: STRIPE_DONATE_URL },
  { label: "$100", url: STRIPE_DONATE_URL },
  { label: "$500", note: "popular", url: STRIPE_DONATE_URL },
  { label: "$1,000", url: STRIPE_DONATE_URL },
];

const USES = [
  "Keeping the protocol and benchmark open, neutral, and Apache-2.0 — never paywalled.",
  "Research on the weak-over-strong supervision layer: intent kernels, pre-action audit, evidence ledgers.",
  "Running the neutral detector benchmark on shared corpora, so vendors compete on a level field.",
  "Maintaining the agent, sandbox, and gateway integrations people rely on in production.",
];

function TopBar() {
  return (
    <header className="sticky top-0 z-30 backdrop-blur bg-ink/70 border-b border-white/[0.06]">
      <div className="container-x flex items-center justify-between h-16">
        <a href="/" className="flex items-center gap-2.5 font-bold tracking-tight">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.svg" alt="OpenGuardrails" className="h-7 w-auto" />
          <span>Open<span className="text-accent">Guardrails</span></span>
          <span className="ml-2 text-xs font-normal text-zinc-500 border-l border-white/10 pl-2">Donate</span>
        </a>
        <nav className="hidden md:flex items-center gap-7 text-sm text-zinc-400">
          <a href="/" className="hover:text-white transition-colors">Home</a>
          <a href="/mission/" className="hover:text-white transition-colors">Mission</a>
          <a href="/docs/" className="hover:text-white transition-colors">Docs</a>
          <a href={GH} className="hover:text-white transition-colors">GitHub</a>
        </nav>
      </div>
    </header>
  );
}

export default function DonatePage() {
  return (
    <main>
      <TopBar />

      {/* Hero + donate box */}
      <section className="container-x pt-24 pb-12 text-center">
        <p className="eyebrow mb-5">Fund AGI endgame safety</p>
        <h1 className="text-4xl sm:text-6xl font-bold tracking-tight leading-[1.06] max-w-3xl mx-auto">
          Help keep human authority over{" "}
          <span className="text-accent">strong AI</span>.
        </h1>
        <p className="mt-7 max-w-2xl mx-auto text-lg text-zinc-400">
          OpenGuardrails builds a controllable weak-AI supervision layer so people can hand real work
          to strong AI without handing over judgment. Donations fund that mission — directly.
        </p>

        <div className="card p-8 border-accent/25 max-w-xl mx-auto mt-10 text-left">
          <p className="eyebrow mb-4 text-center">Choose an amount</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
            {PRESETS.map((p) => (
              <a
                key={p.label}
                href={p.url}
                target="_blank"
                rel="noopener noreferrer"
                className={`relative rounded-xl px-4 py-4 text-center font-semibold border transition ${
                  p.note
                    ? "bg-accent/15 border-accent/40 text-accent hover:bg-accent/25"
                    : "border-white/15 text-zinc-200 hover:bg-white/5"
                }`}
              >
                {p.label}
                {p.note && (
                  <span className="block text-[10px] font-normal uppercase tracking-wider text-accent/80 mt-0.5">
                    {p.note}
                  </span>
                )}
              </a>
            ))}
          </div>
          <a
            href={STRIPE_DONATE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="block rounded-lg px-5 py-3 bg-accent text-ink font-semibold text-center hover:bg-blue-300 transition"
          >
            Donate any amount →
          </a>
          <p className="mt-4 text-xs text-zinc-500 text-center leading-relaxed">
            Secure checkout via Stripe. One-time or recurring. Cards and major wallets accepted.
          </p>
        </div>
        <p className="mt-6 max-w-xl mx-auto text-xs text-zinc-600 leading-relaxed">
          OpenGuardrails is a US-registered solo LLC, not a 501(c)(3). Donations are gifts to the
          mission and are <span className="text-zinc-400">not tax-deductible</span>.
        </p>
      </section>

      {/* Where it goes */}
      <section className="container-x py-12 max-w-3xl mx-auto">
        <p className="eyebrow mb-3">Where your money goes</p>
        <h2 className="text-3xl font-bold mb-6">All of it funds the mission</h2>
        <ul className="space-y-4">
          {USES.map((u) => (
            <li key={u} className="flex gap-3 text-[15px] text-zinc-300 leading-relaxed">
              <span className="text-accent mt-0.5 shrink-0">→</span>
              <span>{u}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* Transparency / alignment */}
      <section className="container-x py-12 max-w-3xl mx-auto">
        <div className="card p-8">
          <p className="eyebrow mb-3">Why a donation goes where it should</p>
          <h2 className="text-2xl font-bold mb-4">Owned so the mission can&apos;t be bent</h2>
          <div className="space-y-4 text-[15px] text-zinc-300 leading-relaxed">
            <p>
              OpenGuardrails is a solo LLC, founder-funded and 100% founder-held, so it doesn&apos;t
              have to treat shareholder profit as the final goal. It runs more like a public-benefit
              company, and may convert to a public-benefit corporation as it grows.
            </p>
            <p>
              We sustain the work two ways — direct donations and commercial projects — and{" "}
              <span className="text-zinc-100 font-semibold">all of that income goes to AGI endgame
              safety.</span> Within six months we&apos;ll seat a social-responsibility committee to
              hold us to these commitments.
            </p>
          </div>
          <p className="mt-5 text-sm text-zinc-500">
            Read the full <a href="/mission/" className="text-accent hover:underline">mission</a>.
          </p>
        </div>
      </section>

      {/* Other ways */}
      <section className="container-x py-12 max-w-3xl mx-auto">
        <p className="eyebrow mb-3">Other ways to support</p>
        <h2 className="text-3xl font-bold mb-6">Money is one of several</h2>
        <div className="grid sm:grid-cols-3 gap-5">
          <div className="card p-6">
            <h3 className="text-[15px] font-semibold mb-2 text-zinc-100">Sponsor a commercial project</h3>
            <p className="text-sm text-zinc-400 leading-relaxed">
              Need OGR deployed or extended for your org? Commercial work funds the mission too.{" "}
              <a href="mailto:thomas@openguardrails.com" className="text-accent hover:underline">Email us</a>.
            </p>
          </div>
          <div className="card p-6">
            <h3 className="text-[15px] font-semibold mb-2 text-zinc-100">Contribute on GitHub</h3>
            <p className="text-sm text-zinc-400 leading-relaxed">
              Spec, detectors, integrations, the benchmark — contribute from anywhere.{" "}
              <a href={GH} className="text-accent hover:underline">github.com/openguardrails</a>.
            </p>
          </div>
          <div className="card p-6">
            <h3 className="text-[15px] font-semibold mb-2 text-zinc-100">Spread the word</h3>
            <p className="text-sm text-zinc-400 leading-relaxed">
              Star the repos, share the mission, and bring the weak-over-strong idea to people who
              are handing real work to AI.
            </p>
          </div>
        </div>
      </section>

      <section className="container-x py-12 max-w-3xl mx-auto">
        <div className="flex flex-wrap items-center gap-3">
          <a href={STRIPE_DONATE_URL} target="_blank" rel="noopener noreferrer" className="rounded-lg px-5 py-3 bg-accent text-ink font-semibold hover:bg-blue-300 transition">
            Donate →
          </a>
          <a href="/mission/" className="rounded-lg px-5 py-3 border border-white/15 font-semibold hover:bg-white/5 transition">
            Read the mission
          </a>
          <a href="mailto:thomas@openguardrails.com" className="rounded-lg px-5 py-3 border border-white/15 font-semibold hover:bg-white/5 transition">
            thomas@openguardrails.com
          </a>
        </div>
      </section>

      <footer className="border-t border-white/[0.06] mt-6 py-10">
        <div className="container-x text-sm text-zinc-500">
          <a href="/" className="hover:text-white">← Back to home</a>
          <span className="mx-3 text-zinc-700">·</span>
          OpenGuardrails — donations and commercial income both fund AGI endgame safety.
        </div>
      </footer>
    </main>
  );
}
