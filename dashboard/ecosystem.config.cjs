module.exports = {
  apps: [{
    name: "og-dashboard-api",
    script: "apps/api/dist/index.js",
    instances: 1,
    autorestart: true,
    max_memory_restart: "512M",
    env: {
      API_PORT: 53667,

      // Database
      DATABASE_URL: "postgresql://user:pass@localhost:5432/og_dashboard",

      // JWT
      JWT_SECRET: "change-me",
      JWT_REFRESH_SECRET: "change-me",

      // Core connection
      OG_CORE_URL: "https://www.openguardrails.com/core",

      // CORS
      WEB_ORIGIN: "https://www.openguardrails.com",
    },
  }],
};
