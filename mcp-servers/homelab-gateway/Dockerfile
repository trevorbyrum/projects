FROM node:20-slim

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy patch script and apply
COPY patch-sdk.cjs ./
RUN node patch-sdk.cjs

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Expose port
EXPOSE 3500

# Start server
CMD ["npm", "start"]
