# Arforge Agent — Dockerized FastAPI service (T35)
# Build: docker build -t arforge-agent .
# Run:   docker run -p 8000:8000 --env-file .env arforge-agent

FROM python:3.12-slim

LABEL org.opencontainers.image.title="Arforge Agent"
LABEL org.opencontainers.image.description="Enterprise-grade local code agent — HTTP + SSE streaming"
LABEL org.opencontainers.image.version="1.0.0"

WORKDIR /app

# System dependencies for OCR (optional)
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    tesseract-ocr-chi-sim \
    && rm -rf /var/lib/apt/lists/*

# Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Application
COPY . .

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')"

EXPOSE 8000

# Run with uvicorn
CMD ["uvicorn", "arforge.api_service:app", "--host", "0.0.0.0", "--port", "8000", "--log-level", "info"]
