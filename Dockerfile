FROM node:24-slim AS build
WORKDIR /src
ENV MONGOMS_DISABLE_POSTINSTALL=1
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-slim
WORKDIR /srv
ENV NODE_ENV=production WEB_ROOT=/srv/web MONGOMS_DISABLE_POSTINSTALL=1
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev -w server
COPY --from=build /src/server/dist server/dist
COPY --from=build /src/web/dist web
USER node
EXPOSE 3000
CMD ["node", "server/dist/main.js"]
