# aimemory 服务端镜像（多阶段：better-sqlite3 原生编译隔离在 build 层）
# 构建：docker build -t aimemory:local .
# 运行：docker compose up -d（数据落 ./data 卷；配置走 .env）
# 验证：scripts/smoke.sh http://127.0.0.1:18543 <口令>

# ---- build：装依赖 + 原生编译（含工具链，prebuild 缺失时兜底） ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# sqlite-vec 是 optionalDependencies：prebuild 拉不到也不阻塞（运行期自动降级关键词检索）
RUN npm ci --omit=dev || (npm config set update-notifier false && npm install --omit=dev)

# ---- runtime：仅运行件，非 root ----
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends sqlite3 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --create-home aimemory
COPY --from=build /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY skills ./skills
COPY scripts ./scripts
COPY docs/api ./docs/api
# config 首启会写 .env（自动生成口令）——预建可写空文件；数据目录归属运行用户
RUN touch .env \
 && mkdir -p /app/data \
 && chown -R aimemory:aimemory /app
USER aimemory
EXPOSE 18543
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||18543)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.js"]
