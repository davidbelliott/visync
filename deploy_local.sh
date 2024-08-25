#!/bin/sh

# Build + deploy the current working version of the site to nginx's html
# directory

cd "$(dirname "$0")/web"
./build.sh
sudo rm -rf /usr/share/nginx/html/*
sudo cp -r dist/* /usr/share/nginx/html/
