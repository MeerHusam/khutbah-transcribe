# Container image for the public listening site. Render's "node" runtime does NOT
# need this (it uses render.yaml), but Railway / Fly.io / a VPS can build from it.
FROM node:20-slim

WORKDIR /app

# Install deps first for better layer caching
COPY package*.json ./
RUN npm install --omit=dev

# App code + the bundled khutbah data (.dockerignore keeps dev/test data out)
COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
