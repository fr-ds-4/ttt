FROM node:24-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
ENV PLAYWRIGHT_BROWSERS_PATH=0
RUN npm ci --omit=dev \
    && npx playwright install --with-deps --only-shell chromium \
    && rm -rf /var/lib/apt/lists/*

COPY run.mjs start-wispbyte.js ./
RUN mkdir -p results && chown node:node results
USER node
CMD ["node", "start-wispbyte.js"]
