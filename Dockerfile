FROM node:24.22.0-alpine

WORKDIR /app

COPY . .

RUN mkdir -p uploads && \
    [ -f media1.mp3 ] && mv media1.mp3 uploads/ || true && \
    [ -f media3.mp4 ] && mv media3.mp4 uploads/ || true && \
    [ -f media4.mp4 ] && mv media4.mp4 uploads/ || true

EXPOSE 3000

CMD ["node", "server.js"]
