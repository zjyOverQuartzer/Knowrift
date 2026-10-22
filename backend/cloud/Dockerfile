FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY frontend/package.json ./frontend/package.json
COPY backend/package.json ./backend/package.json
RUN npm ci --workspace @knowrift/backend --include-workspace-root=false --omit=dev --ignore-scripts
COPY backend/core ./backend/core
COPY backend/cloud ./backend/cloud
COPY backend/fixtures ./backend/fixtures
RUN mkdir -p /data && chown node:node /data
USER node
ENV HOST=0.0.0.0 PORT=4319 DATA_DIR=/data
EXPOSE 4319
VOLUME /data
CMD ["node", "backend/cloud/server.mjs"]
