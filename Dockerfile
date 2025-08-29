# официальное изображение с уже установленными браузерами
FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./

ENV NODE_ENV=production
EXPOSE 10000
CMD ["node", "server.js"]
