FROM oven/bun:latest

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

# Ensure data directory exists
RUN mkdir -p data

EXPOSE 4128

# Run database push then start the app
CMD ["sh", "-c", "bun run db:push && bun src/index.tsx"]
