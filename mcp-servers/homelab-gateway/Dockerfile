FROM mcr.microsoft.com/playwright:v1.40.0-jammy

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Install playwright browsers (chromium only)
RUN npx playwright install chromium

# Copy patch script and apply
COPY patch-sdk.cjs ./
RUN node patch-sdk.cjs

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Copy non-TS assets to dist
RUN cp -r src/templates dist/templates

# Expose port
EXPOSE 3500

# Start server
CMD ["npm", "start"]
