FROM python:3.12-slim
WORKDIR /app
COPY . /app
RUN pip install --no-cache-dir .
EXPOSE 8800
# 0.0.0.0 so the container is reachable; policy is bundled, override with a mount:
#   docker run -p 8800:8800 -v $PWD/policy.json:/app/policy.json openguardrails-gateway
ENTRYPOINT ["ogr-gateway", "--host", "0.0.0.0", "--port", "8800"]
