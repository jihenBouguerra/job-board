FROM node:22-alpine
WORKDIR /app
COPY . .
EXPOSE 8765
CMD ["node", "settings_server.js"]
