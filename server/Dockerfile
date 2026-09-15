FROM node:24.17.0-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

RUN addgroup -S -g 10001 dispatcher && adduser -S -u 10001 -G dispatcher dispatcher \
    && mkdir -p /data && chown -R dispatcher:dispatcher /app /data

USER dispatcher
ENV NODE_ENV=production
EXPOSE 8765
CMD ["node", "src/index.mjs"]
