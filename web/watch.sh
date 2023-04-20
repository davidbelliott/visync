#!/bin/sh
npx webpack --watch &
while true; do
    cp dist/* /usr/share/nginx/html
    inotifywait -e close_write dist/*
done
