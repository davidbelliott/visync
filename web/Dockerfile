FROM node:latest AS rave-web-builder
WORKDIR /app
COPY . .
RUN npm i
RUN ./build.sh
