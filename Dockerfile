FROM oven/bun:latest

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

COPY . .

# Ensure data directory exists
RUN mkdir -p data

EXPOSE 4128

# Schema changes are applied explicitly during deployment so a container restart
# cannot unexpectedly mutate the production database.
CMD ["bun", "src/index.tsx"]
