# Use official Node.js 20 image
FROM node:20-alpine

# Install git and python (required by baileys and native modules)
RUN apk add --no-cache git python3 make g++

# Set working directory
WORKDIR /app

# Copy package files first (for layer caching)
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy rest of the code
COPY . .

# Create sessions directory
RUN mkdir -p sessions

# Expose port
EXPOSE 3000

# Start server
CMD ["node", "index.js"]
