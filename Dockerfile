# syntax=docker/dockerfile:1
# Two images from one file: `gateway` (Python, holds MODEL_API_KEY, talks to Meta) and `app` (Node: Axys server + Studio + FFmpeg).

FROM python:3.11-slim-bookworm AS gateway
WORKDIR /srv
RUN useradd --create-home --uid 10001 gateway
COPY gateway/requirements.txt gateway/requirements.txt
RUN pip install --no-cache-dir -r gateway/requirements.txt
COPY gateway/ gateway/
USER gateway
EXPOSE 8766
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8766/v1/health', timeout=4).status==200 else 1)"
CMD ["python", "-m", "uvicorn", "gateway.server:app", "--host", "0.0.0.0", "--port", "8766"]


FROM node:22-bookworm-slim AS app
# ffmpeg renders the reels; fonts are needed for the text layers (Arial-metric Liberation + DejaVu; Anton ships in the repo).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fontconfig fonts-liberation fonts-dejavu-core ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build
ENV NODE_ENV=production \
    AXYS_PORT=4310 \
    AXYS_DATA_DIR=/data
RUN mkdir -p /data && chown -R node:node /data /srv
USER node
VOLUME ["/data"]
EXPOSE 4310
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s \
  CMD node -e "const p=process.env.AXYS_PORT||process.env.PORT||4310;fetch('http://127.0.0.1:'+p+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "start"]


# Single-container image for platforms that run one service (Render, Railway, Fly.io ...).
# Gateway (loopback only) and app run together; the platform terminates TLS and sets $PORT.
FROM app AS all
USER root
RUN apt-get update  && apt-get install -y --no-install-recommends python3 python3-venv  && rm -rf /var/lib/apt/lists/*  && python3 -m venv /opt/venv  && /opt/venv/bin/pip install --no-cache-dir -r /srv/gateway/requirements.txt  && chmod +x /srv/docker/start.sh
USER node
# Let the platform's $PORT win over the default 4310 set in the app stage.
ENV AXYS_PORT=""
CMD ["/srv/docker/start.sh"]
