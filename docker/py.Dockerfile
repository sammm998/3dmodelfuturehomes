# Python CV / 3D worker (CPU). For Gaussian Splatting on a GPU use py-gpu.Dockerfile.
FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
# optional: corporate/proxy CA certificates (put *.crt files in docker/certs/)
COPY docker/certs/ /usr/local/share/ca-certificates/extra/
RUN cat /usr/local/share/ca-certificates/extra/*.crt >> /etc/ssl/certs/ca-certificates.crt 2>/dev/null || true
ENV PIP_CERT=/etc/ssl/certs/ca-certificates.crt REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
WORKDIR /app
COPY workers/py/requirements.txt workers/py/requirements-dev.txt ./
RUN pip install -r requirements-dev.txt
COPY workers/py/ ./
CMD ["python", "-m", "propertyverse_workers.worker"]
