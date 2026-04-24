FROM oven/bun:latest

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

# Initialize DB (Optional: you might want to do this via a script)
RUN bun run db:push

EXPOSE 4128

CMD ["bun", "src/index.tsx"]
