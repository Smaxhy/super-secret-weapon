# v27.50: the Discord signal copier as its own small container on the VPS (always on, restarts by itself).
# Switched on by COMPOSE_PROFILES=discord + DISCORD_TOKEN in /root/bot/.env (see README.md).
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY bot.py config.example.json ./
ENV PYTHONUNBUFFERED=1 DISCORD_IN_DOCKER=1
CMD ["python", "-u", "bot.py"]
