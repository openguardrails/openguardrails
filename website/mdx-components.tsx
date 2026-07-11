import type { MDXComponents } from "mdx/types";
import type { ReactNode } from "react";

// Styles MDX markdown with the site's dark theme. Required by @next/mdx.
export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    h1: ({ children }) => (
      <h1 className="text-3xl sm:text-4xl font-bold tracking-tight mt-2 mb-4 scroll-mt-24">{children}</h1>
    ),
    h2: ({ children }) => (
      <h2 className="text-2xl font-semibold tracking-tight mt-12 mb-3 scroll-mt-24 border-b border-white/[0.07] pb-2">{children}</h2>
    ),
    h3: ({ children }) => (
      <h3 className="text-lg font-semibold mt-8 mb-2 scroll-mt-24 text-zinc-100">{children}</h3>
    ),
    p: ({ children }) => <p className="text-zinc-400 leading-relaxed my-4">{children}</p>,
    ul: ({ children }) => <ul className="list-disc pl-6 my-4 space-y-1.5 text-zinc-400">{children}</ul>,
    ol: ({ children }) => <ol className="list-decimal pl-6 my-4 space-y-1.5 text-zinc-400">{children}</ol>,
    li: ({ children }) => <li className="leading-relaxed">{children}</li>,
    a: ({ href, children }) => (
      <a href={href} className="text-accent underline-offset-4 hover:underline">{children}</a>
    ),
    strong: ({ children }) => <strong className="text-zinc-200 font-semibold">{children}</strong>,
    code: ({ children, className }: { children?: ReactNode; className?: string }) =>
      className ? (
        // fenced block (has language-* class) — let <pre>.codeblock style it
        <code className={className}>{children}</code>
      ) : (
        <code className="font-mono text-[0.86em] bg-white/[0.06] text-zinc-200 rounded px-1.5 py-0.5">{children}</code>
      ),
    pre: ({ children }: { children?: ReactNode }) => (
      <pre className="codeblock my-5">{children}</pre>
    ),
    table: ({ children }) => (
      <div className="my-6 overflow-x-auto">
        <table className="w-full text-sm border-collapse">{children}</table>
      </div>
    ),
    th: ({ children }) => (
      <th className="text-left font-semibold text-zinc-300 border-b border-white/[0.12] px-3 py-2">{children}</th>
    ),
    td: ({ children }) => (
      <td className="border-b border-white/[0.06] px-3 py-2 text-zinc-400 align-top">{children}</td>
    ),
    blockquote: ({ children }) => (
      <blockquote className="border-l-2 border-accent/50 pl-4 my-5 text-zinc-300 italic">{children}</blockquote>
    ),
    hr: () => <hr className="my-10 border-white/[0.08]" />,
    ...components,
  };
}
