import type { ReactNode } from "react";

/** Light card surface: white, hairline zinc-200 border, rounded-2xl. */
export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`card ${className}`}>{children}</div>;
}

/**
 * Card whose whole surface is a link — used for feature grids.
 * Shows a subtle border/shadow hover state.
 */
export function LinkCard({
  href,
  eyebrow,
  title,
  children,
  cta,
  className = "",
}: {
  href: string;
  eyebrow?: string;
  title: string;
  children: ReactNode;
  cta?: string;
  className?: string;
}) {
  return (
    <a
      href={href}
      className={`card block p-6 hover:border-zinc-300 hover:shadow-sm transition group ${className}`}
    >
      {eyebrow && <p className="text-xs font-mono text-zinc-500 mb-2">{eyebrow}</p>}
      <h3 className="font-semibold text-zinc-900 mb-2 group-hover:text-accent transition-colors">
        {title}
      </h3>
      <div className="text-sm text-zinc-600 leading-relaxed">{children}</div>
      {cta && <p className="mt-4 text-sm font-semibold text-accent">{cta} →</p>}
    </a>
  );
}
