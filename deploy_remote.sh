#!/bin/sh

# Build + deploy the current working version of the site to nginx's html
# directory

REMOTE="raspberrypi"
REMOTE_DIR="visync-dist"

cd "$(dirname "$0")"

ssh $REMOTE "mkdir -p '$REMOTE_DIR'"

./web/build.sh
rsync -avz ./web/dist $REMOTE:"$REMOTE_DIR/"
rsync -avz ./adapter $REMOTE:"$REMOTE_DIR/"

ssh $REMOTE <<EOF
    sudo rm -rf /usr/share/nginx/html
    sudo cp -r $REMOTE_DIR/dist /usr/share/nginx/html
EOF


# TODO: integrate this other repo!
# rsync -avz ../works/life/bin $REMOTE:"$REMOTE_DIR/"

ssh $REMOTE <<EOF
    sudo cp -r $REMOTE_DIR/bin /usr/share/nginx/html/life
EOF
