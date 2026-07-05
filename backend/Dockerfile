FROM python:3.12-slim

WORKDIR /app

# curl_cffi's TLS-impersonation needs a CA bundle; libstdc++6 ships in the base image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

ENV PYTHONUNBUFFERED=1 \
    SESSION_STORE_PATH=/data/flipkart-session.json

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
