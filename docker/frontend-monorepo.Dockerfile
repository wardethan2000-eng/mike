# Upstream builds the frontend with `context: ./frontend`, but
# frontend/src/app/components/shared/types.ts imports its shared types from
# ../../../../../backend/src/lib/sourceDocuments - a path outside that context.
# TypeScript then treats them as implicitly `any` and the build fails.
# Building from the repo root, with that one standalone types file placed where
# the import expects it, fixes it without changing any tracked file.
FROM node:22-slim

WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
COPY backend/src/lib/sourceDocuments.ts /app/backend/src/lib/sourceDocuments.ts

ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY
ARG NEXT_PUBLIC_API_BASE_URL=http://localhost:3001
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY \
    NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL

RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]
