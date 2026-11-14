FROM node:22-alpine
WORKDIR /app
COPY server.mjs near.mjs relay.mjs ./
USER node
CMD ["node", "server.mjs"]
