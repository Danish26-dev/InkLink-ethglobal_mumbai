# Inklink Strands Agent (Vertex AI Gemini reasoning + tool orchestration)
# The @strands-agents/sdk requires Node 22+.
FROM node:22-slim

WORKDIR /app

COPY package*.json ./
# @strands-agents/sdk declares strict optional peer deps; use legacy resolution
# and install from the lockfile for reproducible builds.
RUN npm ci --legacy-peer-deps

COPY . .

# Vertex AI uses Application Default Credentials from the runtime identity
# (e.g. a workload service account). No credentials are baked into the image.
ENV PORT=4000 \
    HOST=0.0.0.0 \
    NODE_ENV=production
EXPOSE 4000

USER node

# Runs the TypeScript entry via tsx (matches local dev).
CMD ["npm", "run", "start:dev"]
