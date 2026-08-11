import createMDX from "@next/mdx";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export", // static HTML in ./out — deployable by nginx
  images: { unoptimized: true },
  trailingSlash: true,
  pageExtensions: ["ts", "tsx", "js", "jsx", "md", "mdx"],
};

// remark-gfm enables GitHub-flavored markdown (tables, strikethrough, autolinks)
// rehype-slug gives every heading an id, so #fragment links can land on it
const withMDX = createMDX({
  options: { remarkPlugins: [remarkGfm], rehypePlugins: [rehypeSlug] },
});

export default withMDX(nextConfig);
