FROM node:20-alpine

RUN apk add --no-cache git tzdata ca-certificates
ENV TZ=America/Sao_Paulo

WORKDIR /app
COPY package.json /app/
RUN npm install --omit=dev --no-package-lock
COPY scheduler.mjs /app/

# Volume para persistir o clone do repo entre restarts (opcional)
VOLUME ["/app/repo"]

CMD ["node", "scheduler.mjs"]
