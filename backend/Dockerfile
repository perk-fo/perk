# @perk/api — indexer + read API. Build context: repo root (needs contracts/deployments for the generated files).
#   docker build -f backend/Dockerfile -t perk-api .
#   docker run --env-file backend/.env -p 8787:8787 perk-api            # sync + serve
#   docker run ... perk-api --sync-only | --serve-only                   # split roles
FROM oven/bun:1.4 AS base
WORKDIR /app
# patches/ must come along: package.json declares patchedDependencies, and bun refuses to install without the
# patch file present.
COPY backend/package.json backend/bun.lock ./
COPY backend/patches ./patches
RUN bun install --frozen-lockfile --production
COPY backend/src ./src
COPY backend/migrations ./migrations
ENV NODE_ENV=production
# MEDIA_DIR with the local driver holds files that launched tokens reference by their on-chain tokenURI, so it must
# outlive the container. Declared as a volume; mount real storage over it (or use MEDIA_DRIVER=pinata) in production.
ENV MEDIA_DIR=/data/media
VOLUME ["/data/media"]
RUN mkdir -p /data/media && chown -R bun:bun /data
EXPOSE 8787
USER bun
ENTRYPOINT ["bun", "run", "src/main.ts"]
