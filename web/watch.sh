#!/bin/sh
npx webpack --watch &
while true; do
    cp -r ./glsl ./dist/
    cp -r ./stl ./dist/
    cp -r ./img ./dist/
    sudo cp -r ./dist/* /usr/share/nginx/html
    inotifywait -e close_write ./dist/* ./glsl/* ./stl/*
done
