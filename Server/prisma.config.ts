import { defineConfig } from 'prisma/config';

// Prisma CLI configuration (migrations, generate).
// DATABASE_URL comes from the environment: Docker Compose sets it for the backend
// container; for local development put it in .env (loaded by Node's --env-file in scripts
// or by your shell).
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? '',
  },
});
