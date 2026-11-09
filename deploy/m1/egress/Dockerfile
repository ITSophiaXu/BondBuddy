# Allow-list forward proxy: the only route out of the internal network.
FROM alpine:3.22
ARG BB_RELEASE_SHA=unknown
LABEL org.opencontainers.image.revision=${BB_RELEASE_SHA}
RUN apk add --no-cache squid
COPY --chmod=0755 entrypoint.sh /entrypoint.sh
EXPOSE 3128
USER squid
ENTRYPOINT ["/entrypoint.sh"]
