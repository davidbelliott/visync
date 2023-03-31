#!/bin/sh
while true; do
    cp dist/* /usr/share/nginx/html
    inotifywait -e close_write dist/*
done
