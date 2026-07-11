import createMDX from "@next/mdx";
import remarkGfm from "remark-gfm";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export", // static HTML in ./out — deployable by nginx
  images: { unoptimized: true },
  trailingSlash: true,
  pageExtensions: ["ts", "tsx", "js", "jsx", "md", "mdx"],
};

// remark-gfm enables GitHub-flavored markdown (tables, strikethrough, autolinks)
const withMDX = createMDX({
  options: { remarkPlugins: [remarkGfm] },
});

export default withMDX(nextConfig);
