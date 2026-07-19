FROM node:20
WORKDIR /usr/src/app
COPY package.json ./
RUN npm install
COPY . .
ENV TZ=Asia/Tokyo
CMD [ "npm", "start" ]
