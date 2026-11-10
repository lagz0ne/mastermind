# NATS with the Mastermind config baked in. Build from the repo root:
#   docker build -f deploy/nats/Dockerfile .
FROM docker.io/library/nats:2.15.2
COPY deploy/nats/nats.conf /etc/nats/nats.conf
CMD ["-c", "/etc/nats/nats.conf"]
