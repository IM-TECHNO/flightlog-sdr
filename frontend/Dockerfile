# --- build ---------------------------------------------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# NEXT_PUBLIC_* is baked in at build time. Empty = "same host the page was opened from, port 8000".
ARG NEXT_PUBLIC_API_URL=""
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
# Cesium + Turbopack is memory hungry: cap the heap and the number of build workers.
ARG NEXT_BUILD_CPUS=2
ENV NODE_OPTIONS=--max-old-space-size=4096 NEXT_BUILD_CPUS=$NEXT_BUILD_CPUS NEXT_OUTPUT=standalone
RUN npm run build

# --- run -----------------------------------------------------------------------------------------------
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 3000
USER node
CMD ["node", "server.js"]
