FROM node:20-alpine

WORKDIR /app

# 先复制依赖文件，利用 Docker 缓存层
COPY package*.json ./

# 安装依赖（含 mongodb）
RUN npm install --production --registry https://registry.npmmirror.com

# 复制源码
COPY . .

# 暴露端口
EXPOSE 3000

CMD ["node", "index.js"]
