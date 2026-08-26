FROM oven/bun:latest

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

# Ensure data directory exists
RUN mkdir -p data

EXPOSE 4128

# Schema changes are applied explicitly during deployment so a container restart
# cannot unexpectedly mutate the production database.
CMD ["bun", "src/index.tsx"]
