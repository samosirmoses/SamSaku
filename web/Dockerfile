FROM node:22-alpine AS build
WORKDIR /web
COPY package*.json ./
RUN npm install --no-audit --no-fund
COPY . .
ARG NEXT_PUBLIC_API_URL=http://localhost:8000/v1
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
RUN npm run build

# Production edge: Caddy serves static export directly + reverse-proxies /v1/* and /health (no extra Nginx container)
FROM caddy:2-alpine AS caddy
COPY --from=build /web/out /srv/web

# Local dev container target (compose.yaml)
FROM nginx:alpine AS local
COPY --from=build /web/out /usr/share/nginx/html
