# baresip sidecar for the native SIP engine (V2-DESK-02).
#
# Builds libre + baresip from source with only the modules the engine needs:
#   ctrl_tcp  netstring/JSON control socket the engine's BaresipAdapter talks to
#   menu      command handlers (dial, accept, hangup, hold, transfer, ...)
#   g711      G.711 codecs Asterisk offers on the plain-SIP endpoints
#   ausine    sine-wave audio source  (headless tests: no sound card)
#   aufile    WAV file player/source  (headless tests: discard remote audio)
#
#   docker build -t sipkit/baresip-sidecar:4.12 packages/engine-native/sidecar
#   docker run --rm -p 4444:4444 sipkit/baresip-sidecar:4.12
#
# Production desktop builds bundle a native baresip binary per OS instead
# (see docs/native-engine.md); this image is for tests and Linux hosts.
ARG DEBIAN=trixie-slim
FROM debian:${DEBIAN} AS build
ARG RE_VERSION=v4.12.0
ARG BARESIP_VERSION=v4.12.0
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git cmake make gcc g++ pkg-config \
      libssl-dev zlib1g-dev \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone --depth 1 --branch ${RE_VERSION} https://github.com/baresip/re.git \
 && git clone --depth 1 --branch ${BARESIP_VERSION} https://github.com/baresip/baresip.git
RUN cmake -S re -B re/build -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/opt/baresip \
 && cmake --build re/build -j"$(nproc)" \
 && cmake --install re/build
RUN cmake -S baresip -B baresip/build -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_INSTALL_PREFIX=/opt/baresip -DCMAKE_PREFIX_PATH=/opt/baresip \
      -DSTATIC=ON \
      -DMODULES="menu;ctrl_tcp;g711;ausine;aufile" \
 && cmake --build baresip/build -j"$(nproc)" \
 && cmake --install baresip/build

FROM debian:${DEBIAN}
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libssl3t64 zlib1g \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 10001 baresip
COPY --from=build /opt/baresip /opt/baresip
COPY --chown=baresip:baresip config /home/baresip/.baresip/config
COPY --chown=baresip:baresip accounts /home/baresip/.baresip/accounts
ENV PATH=/opt/baresip/bin:$PATH LD_LIBRARY_PATH=/opt/baresip/lib
USER baresip
WORKDIR /home/baresip
EXPOSE 4444/tcp 5060/udp
# -f: config dir; -n: no stdin UI (control happens over ctrl_tcp only).
ENTRYPOINT ["baresip", "-f", "/home/baresip/.baresip"]
