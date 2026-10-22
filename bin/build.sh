#!/bin/bash

# build extension
pwdStr="$(pwd)"
echo "$pwdStr"
cross-env NODE_ENV=production webpack --mode production --devtool hidden-source-map

# build image-compressor
cd ./src/modules/image-compressor/webview
npm run build
buildImageCompressor="rsync -avz --delete ./dist/ $pwdStr/dist/image-compressor-dist/"
eval "$buildImageCompressor"

# 裁掉 Linux 原生库：本项目不支持 Linux，而 Linux 上跑 npm install 会自带一份
# linux 的 libvips + sharp .node（约 17MB），不打掉就白占体积、还留个会崩的雷。
node "$pwdStr/scripts/prune-dist-native.js"