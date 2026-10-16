FROM node:24.22.0-alpine

WORKDIR /app

COPY server.js pptx-gen.js kanshasai-quiz-3003.json media1.mp3 media3.mp4 media4.mp4 ./
RUN mkdir -p uploads

EXPOSE 3000

CMD ["node", "server.js"]
