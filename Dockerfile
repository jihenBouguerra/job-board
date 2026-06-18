FROM node:22-alpine
WORKDIR /app
COPY . .
# DATA_DIR is where the SQLite database is stored.
# Mount a persistent volume (e.g. Cloud Storage via GCS FUSE) at /data
# so the database survives container restarts.
ENV DATA_DIR=/data
ENV PORT=8080
EXPOSE 8080
CMD ["node", "settings_server.js"]
