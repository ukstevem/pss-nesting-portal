# Stage 1: Build TypeScript
FROM node:20-slim AS builder
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install
COPY tsconfig.json ./
COPY src/ ./src/
RUN pnpm build

# Stage 2: Production
FROM node:20-slim AS runner

# Install Python 3 + pip for the CP-SAT solver
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-pip python3-venv && \
    rm -rf /var/lib/apt/lists/*

# Install Python dependencies in a venv
COPY solver/requirements.txt /tmp/requirements.txt
RUN python3 -m venv /opt/solver-venv && \
    /opt/solver-venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt && \
    rm /tmp/requirements.txt

# Node.js production dependencies
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/package.json /app/pnpm-lock.yaml* ./
RUN pnpm install --prod --frozen-lockfile || pnpm install --prod

# Application code
COPY --from=builder /app/dist/ ./dist/
COPY solver/ ./solver/

# Directories
RUN mkdir -p /app/outputs/results

# The venv python has ortools; use it as the solver python
ENV NESTING_PYTHON_BIN=/opt/solver-venv/bin/python3
ENV NESTING_SOLVER_SCRIPT=solver/solve.py

EXPOSE 8001
CMD ["node", "dist/index.js"]
