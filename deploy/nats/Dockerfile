# NATS with the Mastermind config baked in (see ../compose.yml).
FROM docker.io/library/nats:2.15.2
COPY nats.conf /etc/nats/nats.conf
CMD ["-c", "/etc/nats/nats.conf"]
