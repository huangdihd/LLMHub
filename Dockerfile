FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY . .
ARG LLMHUB_BUILD_COMMIT=""
ENV LLMHUB_BUILD_COMMIT=$LLMHUB_BUILD_COMMIT LLMHUB_BUILD_DEPLOYMENT=docker
RUN npm ci --include=dev && NITRO_PRESET=node-server npm run build

FROM node:22-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /app/.output ./.output
# Named volumes inherit this ownership; plugins create an npm project here.
RUN mkdir .data && chown node:node .data
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
VOLUME ["/app/.data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/auth/status').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", ".output/server/index.mjs"]
