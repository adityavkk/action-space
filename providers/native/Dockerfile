# Example build recipe, not a qualified or immutable production image.
# Build/review it, then configure a registry digest, never this mutable tag.
FROM python:3.12-slim-bookworm
RUN groupadd --gid 2000 workload && useradd --uid 2000 --gid 2000 --no-create-home --shell /bin/sh workload \
    && mkdir -p /workspace /code /inputs /out /scratch \
    && chown 2000:2000 /workspace /out /scratch
WORKDIR /workspace
USER root
CMD ["sleep", "infinity"]
