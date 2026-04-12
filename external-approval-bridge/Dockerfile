FROM node:20-alpine

WORKDIR /app

COPY package.json server.mjs ./

ENV PORT=8787

EXPOSE 8787

CMD ["node", "server.mjs"]
