# Dev PBX / gateway image: Asterisk 20 (Ubuntu 24.04 "noble" package) with PJSIP,
# WebSocket transport, DTLS-SRTP and ICE. Development use only.
#
# Why the distro package instead of a source build: it is reproducible, fast to
# build and needs no third-party image. Ubuntu 24.04 ships Asterisk 20.x LTS.
# To test against Asterisk 22, swap this for a source build (see README).
FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      asterisk \
      asterisk-core-sounds-en \
      asterisk-moh-opsound-wav \
      gettext-base \
      ca-certificates \
      tini \
 && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

# 5060/udp SIP, 8089/tcp HTTPS+WSS, RTP range is set per service in rtp.conf
EXPOSE 5060/udp 8089/tcp

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
