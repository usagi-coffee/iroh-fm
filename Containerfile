FROM docker.io/library/rust:1-bookworm AS build
RUN apt-get update \
    && apt-get install -y --no-install-recommends mold \
    && rm -rf /var/lib/apt/lists/*
ENV RUSTFLAGS="-C link-arg=-fuse-ld=mold"
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY packages/web/src-tauri ./packages/web/src-tauri
# All workspace members must be present for Cargo manifest resolution.
# Refresh inputs so persistent artifacts cannot hide older checkout changes.
RUN --mount=type=cache,id=iroh-fm-target,target=/build/target,sharing=locked \
    --mount=type=cache,id=iroh-fm-registry,target=/usr/local/cargo/registry,sharing=locked \
    touch Cargo.toml Cargo.lock \
    && find crates packages -type f -exec touch {} + \
    && cargo build --locked --release --package server --bin iroh-fm \
    && mkdir -p /out \
    && cp target/release/iroh-fm /out/iroh-fm

FROM docker.io/library/debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/iroh-fm /usr/local/bin/iroh-fm
ENTRYPOINT ["/usr/local/bin/iroh-fm"]
CMD ["--music-dir", "/music"]
