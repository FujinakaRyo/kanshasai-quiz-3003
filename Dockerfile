FROM node:24.22.0-alpine

WORKDIR /app

COPY server.js pptx-gen.js kanshasai-quiz-3003.json ./
RUN mkdir -p uploads

EXPOSE 3000

CMD ["node", "server.js"]
