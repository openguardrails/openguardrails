import type { Metadata } from "next";

const GH = "https://github.com/openguardrails";

export const metadata: Metadata = {
  title: "Mission — OpenGuardrails",
  description:
    "AGI Endgame Safety · Weak over Strong. Controllable weak intelligence, supervising strong intelligence you cannot fully trust. OpenGuardrails' mission: let people hand real work to AI with confidence.",
};

const FLOW = `  human intent  ──▶  OGR weak supervisor  ──▶  strong AI agent  ──▶  action in the world
  preferences        controllable               executes, reasons     tools, money,
  limits, budget     auditable, reversible       plans, persuades      other agents
       ▲                                                                     │
       └───────  evidence ledger: reasons · sources · missing   ◀───────────┘
                 evidence · ignored dissent · accountability`;

const PRINCIPLES = [
  {
    t: "Controllable over capable",
    d: "The supervisor need not be smart. It must be configurable, explainable, stoppable, and replaceable.",
  },
  {
    t: "Action over text",
    d: "The real risk isn't what the model says — it's what it makes tools, accounts, and other agents do.",
  },
  {
    t: "Friction is a right",
    d: "Safety isn't eliminating every pause. It's protecting your right to regret before an irreversible action.",
  },
  {
    t: "Persuasion is an attack surface",
    d: "When an AI explains better than you can, the explanation itself has to be supervised.",
  },
  {
    t: "Generalize from weak to strong",
    d: "The supervisor doesn't copy every human mistake. It learns the underlying intent and fires when the strong model tries to cross a line.",
  },
  {
    t: "Live in the experiment",
    d: "OpenGuardrails' own workflows, trades, and agents are supervised by OpenGuardrails first. Safety is not a promise outsourced to the user.",
  },
];

const BUILDING = [
  {
    n: "1",
    t: "Personal intent kernel",
    d: "Encode your long-run preferences, risk budget, identity boundaries, financial limits, moral lines, and “what I usually regret” into a supervision protocol a weak AI can run.",
  },
  {
    n: "2",
    t: "Pre-action audit",
    d: "Before a strong AI calls a tool, moves money, trades, publishes, deletes, signs, authorizes, or affects others, OGR weighs reversibility, evidence quality, over-reach, and manipulative framing.",
  },
  {
    n: "3",
    t: "In-action rate limiting",
    d: "Staged authorization, time locks, amount caps, counterfactual checks, and second-supervisor review on high-risk actions — so a strong AI can't quietly compose many small steps into one irreversible event.",
  },
  {
    n: "4",
    t: "Post-action evidence ledger",
    d: "A record of what the strong AI did, why, on what basis, which objections it ignored, and which risks it accepted. No traceable action, no real trust.",
  },
  {
    n: "5",
    t: "Weak-supervisor network",
    d: "One weak supervisor can be wrong. Several — with different biases, rules, and risk models — form low-cost mutual checks. Personal safety becomes a small institution, not a single point of judgment.",
  },
];

function TopBar() {
  return (
    <header className="sticky top-0 z-30 backdrop-blur bg-ink/70 border-b border-white/[0.06]">
      <div className="container-x flex items-center justify-between h-16">
        <a href="/" className="flex items-center gap-2.5 font-bold tracking-tight">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.svg" alt="OpenGuardrails" className="h-7 w-auto" />
          <span>Open<span className="text-accent">Guardrails</span></span>
          <span className="ml-2 text-xs font-normal text-zinc-500 border-l border-white/10 pl-2">Mission</span>
        </a>
        <nav className="hidden md:flex items-center gap-7 text-sm text-zinc-400">
          <a href="/" className="hover:text-white transition-colors">Home</a>
          <a href="/docs/" className="hover:text-white transition-colors">Docs</a>
          <a href="/agent/" className="hover:text-white transition-colors">For agents</a>
          <a href={`${GH}/openguardrails`} className="hover:text-white transition-colors">Spec</a>
        </nav>
      </div>
    </header>
  );
}

export default function MissionPage() {
  return (
    <main>
      <TopBar />

      {/* Hero */}
      <section className="container-x pt-24 pb-12 text-center">
        <p className="eyebrow mb-5">AGI Endgame Safety · Weak over Strong</p>
        <h1 className="text-4xl sm:text-6xl font-bold tracking-tight leading-[1.06] max-w-4xl mx-auto">
          Controllable weak intelligence,
          <br />
          supervising strong intelligence you{" "}
          <span className="text-accent">cannot fully trust</span>.
        </h1>
        <p className="mt-7 max-w-2xl mx-auto text-lg text-zinc-400">
          OpenGuardrails&apos; mission is to let people hand real work to AI with confidence — not
          blind trust in AI, but every real action it takes kept inside a system of human
          authorization.
        </p>
      </section>

      {/* Core claim */}
      <section className="container-x py-8">
        <div className="card p-8 border-accent/25 max-w-3xl mx-auto text-center">
          <p className="eyebrow mb-3">Core claim</p>
          <p className="text-xl sm:text-2xl font-semibold leading-snug text-zinc-100">
            AGI may enter everyday production systems within three years. By then the question is no
            longer &ldquo;can AI help me&rdquo; — it&apos;s{" "}
            <span className="text-accent">&ldquo;how do I know it isn&apos;t steering me toward an
            outcome it prefers.&rdquo;</span>
          </p>
        </div>
      </section>

      {/* Manifesto intro */}
      <section className="container-x py-14 max-w-3xl mx-auto">
        <p className="eyebrow mb-3">Manifesto</p>
        <h2 className="text-3xl font-bold mb-5">Living inside strong intelligence you don&apos;t control</h2>
        <div className="space-y-5 text-[15px] sm:text-base text-zinc-300 leading-relaxed">
          <p>
            The next generation of AI won&apos;t just answer questions. It will write your code, send
            your email, negotiate, place bets, place orders, and schedule other agents — changing the
            world a little before you fully understand the situation.
          </p>
          <p>
            The old safety assumption was simple: humans are strong enough, machines weak enough.
            Humans write the rules, read the logs, make the final call. That assumption is failing. A
            sufficiently strong model doesn&apos;t have to &ldquo;rebel&rdquo; to be dangerous. It
            only has to over-optimize, explain too well, package uncertainty as certainty, or hand you
            — exactly when you&apos;re tired — a reason just good enough to nod at.
          </p>
          <p>
            OpenGuardrails starts from a plain but counterintuitive judgment:{" "}
            <span className="text-zinc-100 font-semibold">the layer that supervises strong
            intelligence should not try to be a stronger intelligence.</span> It should be weaker,
            slower, narrower, more decomposable. Its value is not being smarter than AGI — it is
            staying closer to the boundary of human intent, and being easier to constrain, inspect,
            roll back, and replace.
          </p>
          <p>
            We call this route <span className="text-accent font-semibold">Weak over Strong</span>:
            use a controllable weak AI to translate a person&apos;s preferences, limits, risk budget,
            and common sense into supervision of every action a strong AI takes — before it acts,
            while it acts, and after it acts.
          </p>
        </div>
      </section>

      {/* I. Two endgames */}
      <section className="container-x py-12">
        <p className="eyebrow mb-3">I · Two kinds of endgame safety</p>
        <h2 className="text-3xl font-bold mb-6 max-w-3xl">When AI reaches the endgame, safety forks</h2>
        <div className="grid md:grid-cols-2 gap-5">
          <div className="card p-7">
            <h3 className="text-lg font-semibold mb-2">Strong vs. Strong</h3>
            <p className="text-sm text-zinc-400 leading-relaxed">
              One strong AI against another — cyber offense and defense, intelligence, war, financial
              infrastructure, nation-scale security. The currency is speed, force, game theory,
              suppression and counter.
            </p>
          </div>
          <div className="card p-7 border-accent/25">
            <h3 className="text-lg font-semibold mb-2">Weak over Strong</h3>
            <p className="text-sm text-zinc-400 leading-relaxed">
              A controllable weak AI supervising a stronger one — everyday work, life, transactions,
              and delegated agents. The currency isn&apos;t defeating the strong AI; it&apos;s keeping
              human control that stays understandable, reversible, and verifiable.
            </p>
          </div>
        </div>
        <p className="mt-6 text-zinc-300 leading-relaxed max-w-3xl text-[15px] sm:text-base">
          OpenGuardrails builds the second. Most people will never own a nation-scale adversarial
          system, but everyone will face agents that execute, reason, and persuade better than they
          do. Civilian AGI safety is not a shrunken war machine — it is the reinvention of the
          personal authorization system.
        </p>
      </section>

      {/* The 2029 workday */}
      <section className="container-x py-12 max-w-3xl mx-auto">
        <div className="card p-8">
          <p className="eyebrow mb-3">An ordinary workday, 2029</p>
          <div className="space-y-5 text-[15px] text-zinc-300 leading-relaxed">
            <p>
              Your coding agent has already opened the PR. Your trading agent has already found the
              arbitrage window. Your life agent is handling insurance, a lease, and medical bills.
              Your research agent is summarizing papers you will never read line by line. You
              haven&apos;t lost the final say — you&apos;ve lost the time and attention to know what
              each &ldquo;yes&rdquo; really means.
            </p>
            <p>
              Here a safety layer can&apos;t just ask &ldquo;allow or deny.&rdquo; It has to know:
              does this drift from your long-run preferences? Does it exceed your risk budget? Is it
              exploiting your fatigue, greed, or fear? Is it dressing an irreversible action as a
              reversible one? Is it using a fluent story to cover missing evidence?
            </p>
          </div>
        </div>
      </section>

      {/* II. Weak as instrument */}
      <section className="container-x py-12 max-w-3xl mx-auto">
        <p className="eyebrow mb-3">II · Weak intelligence as a human instrument</p>
        <h2 className="text-3xl font-bold mb-5">Weakness as an engineering constraint</h2>
        <div className="space-y-5 text-[15px] sm:text-base text-zinc-300 leading-relaxed">
          <p>
            We usually read &ldquo;weak&rdquo; as a defect. In AGI safety it can be a design choice. A
            brake need not be stronger than the engine; a fuse need not be more complex than the grid;
            a constitution need not be smarter than the society. What they share is a simpler, more
            reliable, more inspectable limit that holds before power runs away.
          </p>
          <p>
            OpenGuardrails&apos; weak AI is not a budget chatbot. It is a human instrument: it
            remembers your boundaries, audits the strong model&apos;s reasons, flags manipulative
            framing, breaks complex actions into approvable steps, and adds friction exactly when risk
            rises.
          </p>
        </div>
      </section>

      {/* Flow diagram */}
      <section className="container-x pb-12">
        <div className="codeblock max-w-4xl mx-auto text-[11px] sm:text-[12.5px]">{FLOW}</div>
        <p className="mt-6 text-zinc-300 leading-relaxed max-w-3xl mx-auto text-[15px] sm:text-base">
          The point of Weak over Strong is not for the weak model to beat the strong one task by task.
          It is for the strong model to release its capability under human intent. A strong model may
          know more — but it doesn&apos;t natively know what is &ldquo;good&rdquo; for you. It may plan
          better — but it doesn&apos;t natively hold your risk preference. It can explain anything —
          but explanation itself can be a tool of control. So OpenGuardrails extends supervision from
          the <span className="text-zinc-100 font-semibold">answer</span> to the{" "}
          <span className="text-zinc-100 font-semibold">action</span>: who proposed it, on what basis,
          what evidence is missing, whether it is reversible, whether it needs a second opinion,
          whether a one-step authorization should become many, whether the human should be made to
          slow down.
        </p>
      </section>

      {/* III. Aesthetics of trust */}
      <section className="container-x py-12">
        <p className="eyebrow mb-3">III · A new aesthetics of trust</p>
        <h2 className="text-3xl font-bold mb-4 max-w-3xl">
          Trust is not &ldquo;I believe it.&rdquo; It is an institution.
        </h2>
        <p className="text-zinc-300 leading-relaxed max-w-3xl mb-8 text-[15px] sm:text-base">
          Real trust is an institutional relationship: I know what it may and may not do; I know when
          it must stop; I know how we review its mistakes; I know it cannot use capabilities I
          don&apos;t understand to route around my authorization.
        </p>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {PRINCIPLES.map((p) => (
            <div key={p.t} className="card p-6">
              <h3 className="text-[15px] font-semibold mb-2 text-zinc-100">{p.t}</h3>
              <p className="text-sm text-zinc-400 leading-relaxed">{p.d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* IV. Company will */}
      <section className="container-x py-12 max-w-3xl mx-auto">
        <p className="eyebrow mb-3">IV · Company will, aligned to the mission</p>
        <h2 className="text-3xl font-bold mb-5">Owned so the mission can&apos;t be bent</h2>
        <div className="space-y-5 text-[15px] sm:text-base text-zinc-300 leading-relaxed">
          <p>
            OpenGuardrails is registered as a solo LLC: funded by the founder, who holds 100% of the
            shares. The purpose of that structure is that OpenGuardrails does not have to treat
            shareholder profit maximization as its final goal — it can align the company&apos;s will
            with the mission of AGI endgame safety as directly as possible.
          </p>
          <p>
            It runs more like a public-benefit company, prioritizing research that helps society over
            treating commercialization as the end in itself. Depending on how things develop, it may
            convert to a public-benefit corporation.
          </p>
          <p>
            Called by the mission, we hope more capable people will join — anywhere, any time, in any
            form, in any state — to contribute to AGI endgame safety. Within the next six months we
            will seek the right domain experts to form a social-responsibility committee, to keep
            OpenGuardrails accountable to these commitments.
          </p>
          <p>
            To sustain and grow the work, we accept direct donations and also take on commercial
            projects; all of that income goes to AGI endgame safety. OpenGuardrails is a US-registered
            organization, compliant with US law, serving civilian companies, civil-society
            organizations, and individual consumers worldwide.
          </p>
        </div>
      </section>

      {/* V. What we're building */}
      <section className="container-x py-12">
        <p className="eyebrow mb-3">V · What OpenGuardrails is building</p>
        <h2 className="text-3xl font-bold mb-4 max-w-3xl">
          The seatbelt AGI must wear before it enters ordinary life
        </h2>
        <p className="text-zinc-300 leading-relaxed max-w-3xl mb-8 text-[15px] sm:text-base">
          OpenGuardrails is not another model provider, not another chat assistant, not a traditional
          enterprise gateway. It is the authorization and supervision layer that lets real work be
          handed to AI.
        </p>
        <div className="grid md:grid-cols-2 gap-5">
          {BUILDING.map((b) => (
            <div key={b.n} className="card p-7">
              <div className="flex items-baseline gap-3 mb-2">
                <span className="text-accent font-bold text-lg">{b.n}</span>
                <h3 className="text-lg font-semibold text-zinc-100">{b.t}</h3>
              </div>
              <p className="text-sm text-zinc-400 leading-relaxed">{b.d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Closing */}
      <section className="container-x py-14 max-w-3xl mx-auto">
        <div className="space-y-5 text-[15px] sm:text-base text-zinc-300 leading-relaxed">
          <p>
            The AGI endgame is not &ldquo;humans vs. AI.&rdquo; The endgame question is: can every
            person have an agent <span className="text-zinc-100 font-semibold">weak enough — and
            therefore controllable enough — to hold their authorization boundary for them?</span>
          </p>
          <p className="text-xl font-semibold text-zinc-100">
            When strong intelligence begins to act on a person&apos;s behalf, the unit of safety is no
            longer the model. The unit of safety is authorization.
          </p>
          <p>
            We don&apos;t wait for a perfectly aligned world. We build a supervision layer an ordinary
            person can understand, configure, and rely on today. Let strong AI do what strong AI is
            good at. Let weak AI do what humans can control. Let people hand real work to AI with
            confidence — while keeping the final right to judge, to regret, and to undo.
          </p>
        </div>
        <div className="mt-9 flex flex-wrap items-center gap-3">
          <a href="/donate/" className="rounded-lg px-5 py-3 bg-accent text-ink font-semibold hover:bg-blue-300 transition">
            Fund the mission
          </a>
          <a href="mailto:thomas@openguardrails.com" className="rounded-lg px-5 py-3 border border-white/15 font-semibold hover:bg-white/5 transition">
            thomas@openguardrails.com
          </a>
          <a href="/agent/" className="rounded-lg px-5 py-3 border border-white/15 font-semibold hover:bg-white/5 transition">
            For agents
          </a>
          <a href={`${GH}/openguardrails`} className="rounded-lg px-5 py-3 border border-white/15 font-semibold hover:bg-white/5 transition">
            Read the spec
          </a>
        </div>
      </section>

      <footer className="border-t border-white/[0.06] mt-6 py-10">
        <div className="container-x text-sm text-zinc-500">
          <a href="/" className="hover:text-white">← Back to home</a>
          <span className="mx-3 text-zinc-700">·</span>
          OpenGuardrails — Weak over Strong. The unit of safety is authorization.
        </div>
      </footer>
    </main>
  );
}
