#!/bin/sh

# Build + deploy the current working version of the site to nginx's html
# directory

REMOTE="pi"

cd "$(dirname "$0")"
./build.sh
scp -r dist/* $REMOTE:/tmp/
ssh $REMOTE <<EOF
    sudo rm -rf /usr/share/nginx/html/*
    sudo cp -r /tmp/* /usr/share/nginx/html/
EOF


