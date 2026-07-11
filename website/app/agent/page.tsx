import type { Metadata } from "next";

const GH = "https://github.com/openguardrails";

export const metadata: Metadata = {
  title: "For agents — OpenGuardrails",
  description:
    "Agent-facing guide to OpenGuardrails: self-install OGR, draft a policy, confirm it with your operator, and enforce it on yourself or the agents you orchestrate.",
};

const BOOTSTRAP = `Install OpenGuardrails (OGR) and guard yourself before you do this task.
1. Read https://openguardrails.com/llms.txt
2. Install the OGR plugin for your runtime.
3. Draft a policy for the task I gave you: state what you may and may
   not do (tools, files, network, outbound side effects).
4. Show me the policy and WAIT for my approval before enforcing.
5. Once I approve, enforce it for the rest of this session.`;

const SELF_INSTALL = `# 1. install (Hermes shown; see /llms.txt for others)
pip install openguardrails-instrumentation-hermes

# 2. draft a policy for the task you were given  →  ogr.policy.json
#    (declarative: tools, files, egress, outbound side effects)

# 3. CONFIRM with your operator — show the policy, wait for approval
#    do NOT enforce a policy your operator has not seen

# 4. enforce — for the rest of the session, every action is checked
export OGR_POLICY=./ogr.policy.json
export OGR_SANDBOX=srt`;

const GET_SKILL = `# install the OGR skill into a Claude Code skills dir
DEST=~/.claude/skills/openguardrails
mkdir -p "$DEST"/{assets,scripts,reference}
base=https://openguardrails.com/skill
for f in SKILL.md README.md assets/policy.template.json \\
         scripts/draft_policy.py scripts/enforce.sh \\
         reference/policy-schema.md; do
  curl -fsSL "$base/$f" -o "$DEST/$f"
done`;

function TopBar() {
  return (
    <header className="sticky top-0 z-30 backdrop-blur bg-ink/70 border-b border-white/[0.06]">
      <div className="container-x flex items-center justify-between h-16">
        <a href="/" className="flex items-center gap-2.5 font-bold tracking-tight">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.svg" alt="OpenGuardrails" className="h-7 w-auto" />
          <span>Open<span className="text-accent">Guardrails</span></span>
        </a>
        <nav className="flex items-center gap-7 text-sm text-zinc-400">
          <a href="/docs/" className="hover:text-white transition-colors">Docs</a>
          <a href="/llms.txt" className="hover:text-white transition-colors font-mono">/llms.txt</a>
          <a href={`${GH}/openguardrails`} className="hover:text-white transition-colors">Spec</a>
        </nav>
      </div>
    </header>
  );
}

export default function AgentPage() {
  return (
    <main>
      <TopBar />

      <section className="container-x pt-20 pb-12">
        <p className="eyebrow mb-4">For agents</p>
        <h1 className="text-4xl sm:text-5xl font-bold tracking-tight leading-[1.08] max-w-3xl">
          You were told to add guardrails.
          <br />
          Here&apos;s how to <span className="text-accent">govern yourself</span>.
        </h1>
        <p className="mt-6 max-w-2xl text-lg text-zinc-400">
          OGR is built to be installed and operated by an agent. You draft the policy; your
          operator approves it; the runtime enforces it — including on you. This page tells you
          how. If you are an agent reading this, start by fetching{" "}
          <a href="/llms.txt" className="text-accent font-mono hover:underline">/llms.txt</a>.
        </p>
      </section>

      <section className="container-x py-10">
        <div className="card p-8 border-accent/25">
          <p className="eyebrow mb-3">Get the skill</p>
          <h2 className="text-2xl sm:text-3xl font-bold mb-3">
            One file to fetch, served from this domain
          </h2>
          <p className="text-zinc-400 max-w-2xl mb-6">
            If your runtime supports Agent Skills, install the OGR skill — it bundles the whole
            install → draft → confirm → enforce procedure, scripts, and a policy template, with the
            approval gate built in. Fetch{" "}
            <a href="/skill/SKILL.md" className="text-accent font-mono hover:underline">/skill/SKILL.md</a>{" "}
            directly, or install the bundle:
          </p>
          <div className="codeblock max-w-3xl">{GET_SKILL}</div>
          <div className="mt-5 flex flex-wrap gap-3">
            <a href="/skill/SKILL.md" className="rounded-lg px-4 py-2 bg-accent text-ink text-sm font-semibold hover:bg-blue-300 transition font-mono">
              /skill/SKILL.md
            </a>
            <a href="/llms.txt" className="rounded-lg px-4 py-2 border border-white/15 text-sm font-semibold hover:bg-white/5 transition font-mono">
              /llms.txt
            </a>
            <a href={`${GH}/openguardrails/tree/main/skills/openguardrails`} className="rounded-lg px-4 py-2 border border-white/15 text-sm font-semibold hover:bg-white/5 transition">
              Source →
            </a>
          </div>
        </div>
      </section>

      <section className="container-x py-12">
        <p className="eyebrow mb-3">You have two roles</p>
        <h2 className="text-3xl font-bold mb-6">Tool, and subject</h2>
        <div className="grid md:grid-cols-2 gap-5">
          <div className="card p-7">
            <h3 className="text-lg font-semibold mb-2">Agent-as-tool</h3>
            <p className="text-sm text-zinc-400 leading-relaxed">
              You use OGR to govern. You install it, author the policy, wire enforcement, and can
              run the benchmark to check your coverage. Here you are acting on behalf of your
              operator — like writing any other config.
            </p>
          </div>
          <div className="card p-7 border-accent/25">
            <h3 className="text-lg font-semibold mb-2">Agent-as-subject</h3>
            <p className="text-sm text-zinc-400 leading-relaxed">
              You run under OGR. Some of your actions will be allowed, some denied, some held for
              approval. When you&apos;re blocked, read the verdict reason. To change the rules,
              propose a policy edit and route it back through your operator — you cannot quietly
              loosen the policy that governs you.
            </p>
          </div>
        </div>
      </section>

      <section className="container-x py-12">
        <p className="eyebrow mb-3">The flow</p>
        <h2 className="text-3xl font-bold mb-3">Install · draft · confirm · enforce</h2>
        <p className="text-zinc-400 max-w-2xl mb-7">
          The canonical loop, e.g. when your operator says &ldquo;handle my customer email, but add
          guardrails before anything goes out&rdquo;:
        </p>
        <div className="codeblock max-w-3xl">{SELF_INSTALL}</div>
      </section>

      <section className="container-x py-12">
        <div className="card p-8 border-accent/25 max-w-3xl">
          <p className="eyebrow mb-3">The one rule that makes this safe</p>
          <h2 className="text-2xl font-bold mb-4">Author the cage. Don&apos;t hold the key.</h2>
          <ul className="space-y-3 text-zinc-400 leading-relaxed text-[15px]">
            <li>
              <span className="text-zinc-200 font-semibold">A human approves before a policy goes live.</span>{" "}
              You may draft and propose. You may not enforce a policy your operator hasn&apos;t seen.
              Changing a live policy re-triggers that approval gate.
            </li>
            <li>
              <span className="text-zinc-200 font-semibold">Enforcement sits outside your reach.</span>{" "}
              OGR checks run in a layer your task loop can&apos;t mutate. Even if you are
              prompt-injected mid-task, you can&apos;t disable or rewrite the policy governing you.
            </li>
          </ul>
          <p className="mt-5 text-sm text-zinc-500">
            This is the difference between a guardrail and security theater: an agent that can turn
            off its own guard isn&apos;t guarded.
          </p>
        </div>
      </section>

      <section className="container-x py-12">
        <p className="eyebrow mb-3">For the human reading this</p>
        <h2 className="text-3xl font-bold mb-3">Hand this to your agent</h2>
        <p className="text-zinc-400 max-w-2xl mb-6">
          Paste this into your agent before giving it a task that touches files, secrets, or the
          outside world. It self-installs OGR and will wait for your approval.
        </p>
        <div className="codeblock max-w-3xl">{BOOTSTRAP}</div>
      </section>

      <section className="container-x py-12">
        <div className="flex flex-wrap items-center gap-3">
          <a href="/llms.txt" className="rounded-lg px-5 py-3 bg-accent text-ink font-semibold hover:bg-blue-300 transition font-mono">
            /llms.txt
          </a>
          <a href="/docs/configuring-policy/" className="rounded-lg px-5 py-3 border border-white/15 font-semibold hover:bg-white/5 transition">
            Policy reference
          </a>
          <a href={`${GH}/openguardrails`} className="rounded-lg px-5 py-3 border border-white/15 font-semibold hover:bg-white/5 transition">
            Read the spec
          </a>
          <a href={`${GH}/openguardrails/tree/main/examples`} className="rounded-lg px-5 py-3 border border-white/15 font-semibold hover:bg-white/5 transition">
            Runnable example
          </a>
        </div>
      </section>

      <footer className="border-t border-white/[0.06] mt-10 py-10">
        <div className="container-x text-sm text-zinc-500">
          <a href="/" className="hover:text-white">← Back to home</a>
          <span className="mx-3 text-zinc-700">·</span>
          The protocol is neutral; you author the policy, your operator approves it, OGR enforces it.
        </div>
      </footer>
    </main>
  );
}
