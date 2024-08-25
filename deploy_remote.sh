#!/bin/sh

# Build + deploy the current working version of the site to nginx's html
# directory

REMOTE="pi"
REMOTE_DIR="visync-dist"

cd "$(dirname "$0")"
#./build.sh
ssh $REMOTE "mkdir -p '$REMOTE_DIR'"

./web/build.sh
rsync -avz ./web/dist $REMOTE:"$REMOTE_DIR/"
rsync -avz ./adapter $REMOTE:"$REMOTE_DIR/"

ssh $REMOTE <<EOF
    sudo rm -rf /usr/share/nginx/html
    sudo cp -r $REMOTE_DIR/dist /usr/share/nginx/html
EOF
