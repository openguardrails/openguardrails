import type { MDXComponents } from "mdx/types";
import type { ReactNode } from "react";

// Styles MDX markdown with the site's light theme. Required by @next/mdx.
export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    h1: ({ children, id }) => (
      <h1 id={id} className="text-3xl sm:text-4xl font-bold tracking-tight text-zinc-900 mt-2 mb-4 scroll-mt-24">{children}</h1>
    ),
    h2: ({ children, id }) => (
      <h2 id={id} className="text-2xl font-semibold tracking-tight text-zinc-900 mt-12 mb-3 scroll-mt-24 border-b border-zinc-200 pb-2">{children}</h2>
    ),
    h3: ({ children, id }) => (
      <h3 id={id} className="text-lg font-semibold mt-8 mb-2 scroll-mt-24 text-zinc-900">{children}</h3>
    ),
    p: ({ children }) => <p className="text-zinc-700 leading-relaxed my-4">{children}</p>,
    ul: ({ children }) => <ul className="list-disc pl-6 my-4 space-y-1.5 text-zinc-700">{children}</ul>,
    ol: ({ children }) => <ol className="list-decimal pl-6 my-4 space-y-1.5 text-zinc-700">{children}</ol>,
    li: ({ children }) => <li className="leading-relaxed">{children}</li>,
    a: ({ href, children }) => (
      <a href={href} className="text-accent underline-offset-4 hover:underline">{children}</a>
    ),
    strong: ({ children }) => <strong className="text-zinc-900 font-semibold">{children}</strong>,
    code: ({ children, className }: { children?: ReactNode; className?: string }) =>
      className ? (
        // fenced block (has language-* class) — let <pre>.codeblock style it
        <code className={className}>{children}</code>
      ) : (
        <code className="font-mono text-[0.86em] bg-zinc-100 text-zinc-800 rounded px-1.5 py-0.5">{children}</code>
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
      <th className="text-left font-semibold text-zinc-900 border-b border-zinc-300 px-3 py-2">{children}</th>
    ),
    td: ({ children }) => (
      <td className="border-b border-zinc-200 px-3 py-2 text-zinc-700 align-top">{children}</td>
    ),
    blockquote: ({ children }) => (
      <blockquote className="border-l-2 border-accent/40 pl-4 my-5 text-zinc-600 italic">{children}</blockquote>
    ),
    hr: () => <hr className="my-10 border-zinc-200" />,
    ...components,
  };
}
