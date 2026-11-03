# Open-Birdie cloud course service. Build from the repository root:
#   docker build -f cloud/Dockerfile -t open-birdie-cloud .
#   docker run -p 8080:8080 -e BIRDIE_CLOUD_BUILD_TOKEN=... -e S3_ENDPOINT=... open-birdie-cloud
# On Railway set the service variable RAILWAY_DOCKERFILE_PATH=cloud/Dockerfile.
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

# Only the service's own dependencies (pngjs for the course code, geotiff for the
# canopy height tiles, sharp for the tiled aerial) — not the desktop app's
# Electron toolchain. cloud/package.json becomes the image's package.json so the
# shared lib/ code resolves them from /app/node_modules.
COPY cloud/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY lib ./lib
COPY cloud ./cloud

# Scratch space for builds in progress (packages live in the object store).
ENV BIRDIE_DATA_DIR=/tmp/birdie-cloud-staging
ENV PORT=8080
EXPOSE 8080

CMD ["node", "cloud/server.js"]
