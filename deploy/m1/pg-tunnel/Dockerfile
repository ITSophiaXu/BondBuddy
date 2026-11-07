FROM alpine:3.23
RUN apk add --no-cache openssh-client && adduser -D -u 1000 tunnel
COPY --chmod=0755 tunnel.sh /usr/local/bin/pg-tunnel
USER tunnel
ENTRYPOINT ["/usr/local/bin/pg-tunnel"]
