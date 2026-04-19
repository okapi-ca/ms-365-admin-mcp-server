FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run generate && npm run build

FROM node:20-slim
WORKDIR /app
RUN addgroup --system --gid 1001 mcpgroup && \
    adduser --system --uid 1001 --ingroup mcpgroup mcpuser
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
USER mcpuser
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s \
  CMD node -e "fetch('http://localhost:8080/health').then(r=>{if(!r.ok)throw 1}).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js", "--transport", "http", "--port", "8080", "--host", "0.0.0.0"]
