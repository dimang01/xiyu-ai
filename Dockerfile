# syntax=docker/dockerfile:1.6
#
# 溪语 AI · 多阶段 Dockerfile
#
#   $ docker build -t xiyu-ai:latest .
#   $ docker run -d --name xiyu-ai \
#       -p 3000:3000 \
#       -v "$(pwd)/data:/app/data" \
#       --env-file .env \
#       xiyu-ai:latest
#
# better-sqlite3 需要原生编译（python3 + build-essential），所以走 builder
# 阶段编出 node_modules，运行时只带最终产物，镜像更瘦。
#
# Copyright (c) 2026 溪语 AI Contributors. MIT License.

# ─── builder ────────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS builder

ENV NODE_ENV=production
WORKDIR /app

# better-sqlite3 / 其它原生依赖编译所需
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 先拷依赖描述以利用 cache
COPY package.json package-lock.json* ./

# 仅安装生产依赖；原生模块在此处一次性编译
RUN npm ci --omit=dev --no-audit --no-fund

# 拷源码（.dockerignore 控制实际拷贝范围）
COPY . .

# ─── runtime ────────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production \
    API_PORT=3000 \
    DB_PATH=/app/data/bot.db \
    XIYU_DATA_DIR=/app/data

# imagemagick 用于头像 / 场景照后处理（image post-processing pipeline）；
# 不需要图像功能时也可以 docker build --build-arg WITH_IMAGE=0 跳过
ARG WITH_IMAGE=1
RUN if [ "$WITH_IMAGE" = "1" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends imagemagick ca-certificates wget \
      && rm -rf /var/lib/apt/lists/*; \
    else \
      apt-get update && apt-get install -y --no-install-recommends ca-certificates wget && rm -rf /var/lib/apt/lists/*; \
    fi

# 用非 root 用户跑
RUN groupadd --system --gid 1001 xiyu \
    && useradd  --system --uid 1001 --gid xiyu --home-dir /app --shell /sbin/nologin xiyu

WORKDIR /app

COPY --from=builder --chown=xiyu:xiyu /app /app

# data 目录走 volume，启动前确保存在
RUN mkdir -p /app/data /app/logs /app/public/avatars \
    && chown -R xiyu:xiyu /app/data /app/logs /app/public/avatars

USER xiyu

EXPOSE 3000

# 健康检查：未配置 chat provider 也算"running"，但 setup_required 会被 compose 暴露给用户
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --quiet --spider http://127.0.0.1:3000/api/health || exit 1

VOLUME ["/app/data"]

CMD ["node", "index.mjs"]
