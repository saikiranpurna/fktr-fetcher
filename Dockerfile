# Frontend (Next.js, UI only). /api/* is proxied to the Python backend via rewrites.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# BACKEND_URL: server-side rewrite target (build-time). NEXT_PUBLIC_BACKEND_URL: the URL the
# browser calls directly (bypasses the proxy's 30s timeout for the full orders fetch).
ARG BACKEND_URL=http://localhost:8000
ARG NEXT_PUBLIC_BACKEND_URL=
ENV BACKEND_URL=$BACKEND_URL NEXT_PUBLIC_BACKEND_URL=$NEXT_PUBLIC_BACKEND_URL NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-slim AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
