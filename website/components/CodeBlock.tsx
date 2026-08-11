import type { ReactNode } from "react";

/**
 * Light code block with an optional title bar (GitHub-style light gray).
 * `code` is rendered inside a <pre>; pass a plain string.
 */
export function CodeBlock({
  title,
  code,
  className = "",
}: {
  title?: string;
  code: string;
  className?: string;
}) {
  return (
    <div className={`rounded-xl border border-zinc-200 bg-[#f6f8fa] overflow-hidden ${className}`}>
      {title && (
        <div className="px-4 py-2 border-b border-zinc-200 bg-white text-xs font-mono text-zinc-500">
          {title}
        </div>
      )}
      <pre className="p-4 overflow-x-auto font-mono text-[12.5px] leading-relaxed text-zinc-800 whitespace-pre">
        {code}
      </pre>
    </div>
  );
}

/**
 * Dark code pane for hero sections — the one intentional dark surface on the
 * light site. Compose panes inside a `DarkCodePanel`.
 */
export function DarkCodePanel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl bg-zinc-900 border border-zinc-800 text-left overflow-hidden ${className}`}>
      {children}
    </div>
  );
}

export function DarkCodePane({ label, code }: { label: string; code: string }) {
  return (
    <div className="min-w-0">
      <div className="px-5 pt-4 pb-2 text-[11px] font-mono uppercase tracking-[0.2em] text-zinc-500">
        {label}
      </div>
      <pre className="px-5 pb-5 overflow-x-auto font-mono text-[12.5px] leading-relaxed text-zinc-200 whitespace-pre">
        {code}
      </pre>
    </div>
  );
}
