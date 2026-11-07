FROM mcr.microsoft.com/playwright:v1.64.1-noble

WORKDIR /app
RUN npm install --no-save --no-package-lock --no-audit --no-fund playwright@1.64.1
COPY run.mjs /app/run.mjs

RUN printf '%s\n' \
    '#!/bin/sh' \
    'cd /tmp || exit 1' \
    'node /app/run.mjs' \
    'status=$?' \
    'echo "run.mjs exited with code $status"' \
    'exec sleep infinity' \
    > /usr/local/bin/start-worker \
    && chmod +x /usr/local/bin/start-worker

CMD ["/usr/local/bin/start-worker"]
