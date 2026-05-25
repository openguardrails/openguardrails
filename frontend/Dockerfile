FROM node:18-alpine AS builder

WORKDIR /app

# Copy package files
COPY frontend/package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY frontend/ .

# Build parameters: allow setting Vite base prefix
ARG VITE_BASE=/platform/
ENV VITE_BASE=${VITE_BASE}

# Build project (inject VITE_BASE)
RUN VITE_BASE=${VITE_BASE} npm run build

# Production stage
FROM nginx:alpine

# Copy build artifacts to platform directory
COPY --from=builder /app/dist /usr/share/nginx/html/platform

# Copy landing page
COPY landing /usr/share/nginx/html/landing

# Copy nginx configuration
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf

# Expose port
EXPOSE 80

# Start nginx
CMD ["nginx", "-g", "daemon off;"]