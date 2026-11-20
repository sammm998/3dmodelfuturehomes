# GPU worker with nerfstudio (splatfacto) for Gaussian Splatting. Requires an NVIDIA GPU +
# nvidia-container-toolkit. Build is large (~15 GB) and is NOT needed for the rest of the system.
FROM nvidia/cuda:12.4.1-devel-ubuntu22.04
ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1 TCNN_CUDA_ARCHITECTURES="75;80;86;89"
RUN apt-get update && apt-get install -y --no-install-recommends python3.10 python3-pip git colmap ffmpeg libglib2.0-0 libgl1 && rm -rf /var/lib/apt/lists/*
RUN pip3 install --no-cache-dir torch==2.4.1 torchvision --index-url https://download.pytorch.org/whl/cu124 \
 && pip3 install --no-cache-dir nerfstudio gsplat
WORKDIR /app
COPY workers/py/requirements.txt ./
RUN pip3 install --no-cache-dir -r requirements.txt
COPY workers/py/ ./
ENV SPLAT_LOCAL=auto PY_WORKER_CONCURRENCY=1
CMD ["python3", "-m", "propertyverse_workers.worker"]
