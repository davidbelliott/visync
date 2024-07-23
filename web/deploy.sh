#!/bin/sh

# Build + deploy the current working version of the site to nginx's html
# directory

./build.sh
sudo cp -r dist/* /usr/share/nginx/html/
