FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends mono-mcs git btrfs-progs xfsprogs util-linux && rm -rf /var/lib/apt/lists/*
WORKDIR /work
RUN npm init -y && npm pkg set type=module && npm install --ignore-scripts execa@9 commander@15 yaml@2 zod@4 tsx@4 vitest@3
