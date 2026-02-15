/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@og/shared"],
  ...(process.env.DASHBOARD_MODE === "embedded" ? { output: "export" } : {}),
};

module.exports = nextConfig;
