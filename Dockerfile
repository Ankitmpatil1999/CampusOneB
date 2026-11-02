# API and worker image (one code base, two commands — ADR-0002). Build from this folder:
#   docker build -t campusone-backend-api .
#   docker run campusone-backend-api                          # API (dist/server.js)
#   docker run campusone-backend-api node dist/worker.js      # worker
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000 3001
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/health/live || exit 1
CMD ["node", "dist/server.js"]
