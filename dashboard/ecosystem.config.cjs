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
      // DATABASE_URL: "postgresql://user:pass@localhost:5432/og_dashboard",

      // JWT
      JWT_SECRET: "q6uhqpNtCgD+0AsOBpaX70XXcztxQCGrismJ8Hqxu6eJZZ6gA+PRHrZ2ihb8dDy1A5r851KOa92LxUz2b5fsbQ==",
      JWT_REFRESH_SECRET: "P+W6vO49jdI6FvzZpVEGiA3DBR0tj5vkrLbRus0jnNr1KDC9HTX/0TaiVbzpmQCXHTzCeh3UJGNfOLCtixcCiQ==",

      // Core connection
      OG_CORE_URL: "https://www.openguardrails.com/core",

      // CORS
      WEB_ORIGIN: "https://www.openguardrails.com/dashboard",
    },
  }],
};
