# Production image for deploying off your own machine (Railway, Render,
# Fly.io, etc). Not used by `npm run dev` — that's still the right command
# for local development against your dev store.

FROM node:20-alpine

# Prisma's engine binaries need real OpenSSL present in the image — Alpine's
# base image doesn't include it, which causes "Could not parse schema engine
# response" crashes at runtime (the engine fails to start at all).
RUN apk add --no-cache openssl

WORKDIR /app

# Install ALL dependencies here, including devDependencies — the build
# step below needs Vite and Remix's dev tooling to compile the app.
# NODE_ENV is intentionally NOT set to production yet, since that would
# make npm skip devDependencies too.
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

COPY . .
RUN npx prisma generate
RUN npm run build

# Now that build/ exists, drop devDependencies to slim the image — the
# running server doesn't need Vite/Remix's dev tooling anymore.
RUN npm prune --omit=dev --ignore-scripts && npm cache clean --force

ENV NODE_ENV=production
EXPOSE 3000

# "docker-start" runs `prisma db push` (creates/updates tables against
# whatever DATABASE_URL points at) and then starts the server — see
# package.json. That keeps the schema in sync automatically on every
# deploy without a separate manual migration step.
CMD ["npm", "run", "docker-start"]