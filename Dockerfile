# RFP Sweep and Drafter: the internal host (docs/internal-hosting.md).
#
# Playwright's image: Node plus a headless Chromium, so the portals that build their
# listings with JavaScript are read on the host too. The tag matches the playwright
# version in package-lock.json; change both together.
#
#   docker build --build-arg RFP_COMMIT=$(git rev-parse HEAD) -t rfp-sweep-drafter .
#   az acr build --registry <acr> --image rfp-sweep-drafter:latest --build-arg RFP_COMMIT=<sha> .
#
# It runs as root inside the container because App Service's persistent /home storage
# needs it. The browser opens only the configured public procurement portals (links a
# person pastes are read as plain pages), every request it makes goes through
# lib/guard.mjs, and the server's own requests reach public addresses only (lib/netguard.mjs).
FROM mcr.microsoft.com/playwright:v1.63.0-noble

ARG RFP_COMMIT=""
ENV NODE_ENV=production \
    RFP_MODE=internal \
    RFP_DATA_DIR=/home/data/rfp-sweep \
    RFP_CONTAINER=1 \
    RFP_COMMIT=${RFP_COMMIT} \
    PORT=8080 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app
COPY package.json package-lock.json ./
# Production dependencies only (Playwright is optional and comes along); no install scripts run.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY . .

EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "scripts/dashboard.mjs"]
