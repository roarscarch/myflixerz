FROM node:20-alpine

WORKDIR /app

# ffmpeg remuxes HLS streams for /download (direct mp4 sources don't need it)
RUN apk add --no-cache ffmpeg

# install deps first (better layer caching)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# app code
COPY server.js ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# handle SIGTERM cleanly so container orchestration stops us politely
CMD ["node", "server.js"]
