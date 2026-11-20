export const env = {
  databaseUrl: process.env.DATABASE_URL || "postgres://propertyverse:propertyverse@localhost:5432/propertyverse",
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
  s3: {
    endpoint: process.env.S3_ENDPOINT || "http://localhost:9000",
    region: process.env.S3_REGION || "us-east-1",
    bucket: process.env.S3_BUCKET || "propertyverse",
    accessKey: process.env.S3_ACCESS_KEY || "propertyverse",
    secretKey: process.env.S3_SECRET_KEY || "propertyverse-secret",
  },
  publicWebUrl: process.env.PUBLIC_WEB_URL || "http://localhost:3000",
  publicApiUrl: process.env.PUBLIC_API_URL || "http://localhost:4000",
  adminToken: process.env.ADMIN_TOKEN || "",
  userAgent:
    process.env.SCRAPER_USER_AGENT ||
    "PropertyVerseBot/0.1 (+https://propertyverse.example/bot; listing import on behalf of the listing agency)",
};
