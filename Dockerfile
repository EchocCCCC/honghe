FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils ca-certificates python3 python3-venv && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY requirements-pdf.txt ./
COPY skills/specification-rule-parser/scripts/requirements.txt ./skills/specification-rule-parser/scripts/requirements.txt
COPY skills/drawing-requirements-matcher/scripts/requirements.txt ./skills/drawing-requirements-matcher/scripts/requirements.txt
RUN python3 -m venv /opt/pdf-runtime && /opt/pdf-runtime/bin/pip install --no-cache-dir -r requirements-pdf.txt
COPY server ./server
COPY public ./public
COPY scripts ./scripts
COPY skills ./skills
RUN mkdir -p runtime && chown -R node:node /app
USER node
ENV HOST=0.0.0.0 PORT=3000 PYTHON_PATH=/opt/pdf-runtime/bin/python
EXPOSE 3000
CMD ["node", "server/app.js"]
